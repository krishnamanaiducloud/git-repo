// backend/index.js
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const simpleGit = require('simple-git');
const path = require('path');
const fs = require('fs-extra');
const os = require('os');
const app = express();
require('dotenv').config();

const port = process.env.PORT || 3000;

app.use(bodyParser.json());

app.use(express.static(path.join(__dirname, 'public/browser'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.css')) {
            res.setHeader('Content-Type', 'text/css');
        }
    }
}));

app.get('/api/config/subgroups', (req, res) => {
    try {
        const subgroups = Object.keys(namespaceMap).map(key => ({
            label: key,
            value: key
        }));
        res.json(subgroups);
    } catch (err) {
        console.error('❌ Failed to load subgroups:', err.message);
        res.status(500).json({ error: 'Failed to load subgroups' });
    }
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/browser', 'index.html'));
});

const GITLAB_API_URL = process.env.GITLAB_API_URL || 'https://gitlab.example.com/api/v4';
const GITLAB_TOKEN = process.env.GITLAB_TOKEN;
const TEMPLATE_REPO_PREFIX = process.env.TEMPLATE_REPO_PREFIX || 'https://gitlab.centene.com/embark/templates-projects/';

const namespaceMap = JSON.parse(process.env.NAMESPACE_MAP);
const templateMap = JSON.parse(process.env.TEMPLATE_MAP);

const validArtifactTypes = {
    Go: ['Image', 'Library'],
    Java: ['Image', 'Library', 'Kjar'],
    Javascript: ['Image', 'Library']
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function ensureProtectedBranch(project_id, branch_name, { push_access_level, merge_access_level, allow_force_push }) {
    try {
        const currentProtection = await axios.get(`${GITLAB_API_URL}/projects/${project_id}/protected_branches`, {
            headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN }
        });

        const branchProtected = currentProtection.data.some(branch => branch.name === branch_name);

        if (branchProtected) {
            console.log(`ℹ️ Branch "${branch_name}" is already protected. Deleting protection...`);

            await axios.delete(`${GITLAB_API_URL}/projects/${project_id}/protected_branches/${encodeURIComponent(branch_name)}`, {
                headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN }
            });

            console.log(`✅ Protection for branch "${branch_name}" deleted.`);
        } else {
            console.log(`ℹ️ Branch "${branch_name}" is not protected yet.`);
        }

        await axios.post(`${GITLAB_API_URL}/projects/${project_id}/protected_branches`, {
            name: branch_name,
            push_access_level,
            merge_access_level,
            allow_force_push
        }, { headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN } });

        console.log(`✅ Branch "${branch_name}" protected with desired settings.`);

    } catch (err) {
        console.error(`❌ Failed to ensure protection for branch "${branch_name}":`, err.response?.data || err.message);
    }
}

async function getProtectedBranchId(project_id, branch_name) {
    try {
        const resp = await axios.get(`${GITLAB_API_URL}/projects/${project_id}/protected_branches`, {
            headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN }
        });
        const branch = resp.data.find(b => b.name === branch_name);
        if (branch) {
            console.log(`✅ Found protected_branch_id for ${branch_name}: ${branch.id}`);
            return branch.id;
        } else {
            console.warn(`⚠️ Protected branch ${branch_name} not found.`);
            return null;
        }
    } catch (err) {
        console.error(`❌ Failed to get protected branches:`, err.response?.data || err.message);
        return null;
    }
}

async function getGroupId(group_search_term) {
    try {
        const resp = await axios.get(`${GITLAB_API_URL}/groups?search=${encodeURIComponent(group_search_term)}`, {
            headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN }
        });
        if (resp.data.length > 0) {
            console.log(`✅ Found group_id for ${group_search_term}: ${resp.data[0].id}`);
            return resp.data[0].id;
        } else {
            console.warn(`⚠️ Group ${group_search_term} not found.`);
            return null;
        }
    } catch (err) {
        console.error(`❌ Failed to get group:`, err.response?.data || err.message);
        return null;
    }
}

async function shareGroupToProject(project_id, group_id) {
    try {
        await axios.post(`${GITLAB_API_URL}/projects/${project_id}/share`, {
            group_id,
            group_access: 30
        }, {
            headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN }
        });
        console.log(`✅ Group ID ${group_id} shared to project.`);
    } catch (err) {
        if (err.response?.data?.message?.includes("Project cannot be shared with the group it is in")) {
            console.log(`⚠️ Group is parent or ancestor, cannot share. Proceeding.`);
        } else if (err.response?.data?.message === 'Group already shared with this group') {
            console.log(`ℹ️ Group ID ${group_id} already shared.`);
        } else {
            console.error(`❌ Failed to share group to project:`, err.response?.data || err.message);
        }
    }
}

async function waitForGroupSync(project_id, group_id, maxRetries = 5) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const resp = await axios.get(`${GITLAB_API_URL}/projects/${project_id}/groups?with_shared=true&shared_min_access_level=20`, {
                headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN }
            });
            const groupFound = resp.data.some(group => group.id === group_id);
            if (groupFound) {
                console.log(`✅ Group ID ${group_id} is confirmed shared to project.`);
                await sleep(1500);
                return;
            } else {
                console.log(`⏳ Waiting for group ID ${group_id} to sync... (${attempt}/${maxRetries})`);
                await sleep(2000);
            }
        } catch (err) {
            console.error(`❌ Failed to check project groups:`, err.response?.data || err.message);
            await sleep(2000);
        }
    }
    console.warn(`⚠️ Group ID ${group_id} did NOT sync after retries.`);
}

app.post('/api/create_repo', async (req, res) => {
    const tmpDir = path.join(os.tmpdir(), `repo-${Date.now()}`);
    try {
        const { projectName, subgroup, technology, artifactType, ownerInfo } = req.body;

        const namespace_id = namespaceMap[subgroup];
        const template_name = artifactType.toLowerCase() === 'kjar'
            ? 'embark-java-image-kjar'
            : `embark-${technology.toLowerCase()}-${artifactType.toLowerCase()}`;

        const template_project_id = templateMap[template_name];
        const repoUrl = `${TEMPLATE_REPO_PREFIX}${template_name}.git`;

        if (!namespace_id) return res.status(400).json({ error: 'Invalid subgroup mapping' });
        if (!validArtifactTypes[technology]?.includes(artifactType)) return res.status(400).json({ error: 'Invalid Technology and Artifact Type' });
        if (!template_project_id) return res.status(400).json({ error: 'Template mapping failed' });

        const projectResp = await axios.post(`${GITLAB_API_URL}/projects`, {
            name: projectName,
            path: projectName.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
            namespace_id,
            visibility: 'internal',
            description: `Owner: ${ownerInfo || 'N/A'}, Technology: ${technology}, Artifact: ${artifactType}`
        }, {
            headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN }
        });

        const project_id = projectResp.data.id;

        const git = simpleGit();
        await git.clone(`https://oauth2:${GITLAB_TOKEN}@${repoUrl.replace('https://', '')}`, tmpDir);
        const gitCloned = simpleGit(tmpDir);
        await gitCloned.removeRemote('origin');
        await gitCloned.addRemote('origin', `https://oauth2:${GITLAB_TOKEN}@gitlab.centene.com/${projectResp.data.path_with_namespace}.git`);
        await gitCloned.push(['-u', 'origin', 'HEAD:master', '--force']);

        await fs.remove(tmpDir);

        await axios.put(`${GITLAB_API_URL}/projects/${project_id}`, {
            default_branch: 'master'
        }, { headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN } });

        await ensureProtectedBranch(project_id, 'master', {
            push_access_level: 0,
            merge_access_level: 30,
            allow_force_push: false
        });

        const masterBranchId = await getProtectedBranchId(project_id, 'master');
        const subgroupGroupId = await getGroupId(subgroup);

        if (masterBranchId && subgroupGroupId) {
            await shareGroupToProject(project_id, subgroupGroupId);
            await waitForGroupSync(project_id, subgroupGroupId);
            try {
                await axios.post(`${GITLAB_API_URL}/projects/${project_id}/approval_rules`, {
                    name: 'Peer Review',
                    approvals_required: 1,
                    rule_type: 'regular',
                    protected_branch_ids: [masterBranchId],
                    applies_to_all_protected_branches: false,
                    branches: ['master'],
                    group_ids: [subgroupGroupId]
                }, { headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN } });
                console.log('✅ Approval rule "Peer Review" added to master');
            } catch (err) {
                console.error('❌ Failed to set approval rule for master:', err.response?.data || err.message);
            }
        }

        let awsMasterExists = false;
        try {
            const branchesResp = await axios.get(`${GITLAB_API_URL}/projects/${project_id}/repository/branches`, {
                headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN }
            });
            awsMasterExists = branchesResp.data.some(branch => branch.name === 'aws_master');
        } catch (err) {
            console.error('❌ Failed to get branches:', err.response?.data || err.message);
        }

        if (!awsMasterExists) {
            try {
                await axios.post(`${GITLAB_API_URL}/projects/${project_id}/repository/branches`, {
                    branch: 'aws_master',
                    ref: 'master'
                }, { headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN } });
                console.log('✅ aws_master branch created from master');
            } catch (err) {
                console.error('❌ Failed to create aws_master branch:', err.response?.data || err.message);
            }
        } else {
            console.log('ℹ️ aws_master branch already exists');
        }

        await ensureProtectedBranch(project_id, 'aws_master', {
            push_access_level: 0,
            merge_access_level: 30,
            allow_force_push: false
        });

        const awsMasterBranchId = await getProtectedBranchId(project_id, 'aws_master');

        if (awsMasterBranchId && subgroupGroupId) {
            await shareGroupToProject(project_id, subgroupGroupId);
            await waitForGroupSync(project_id, subgroupGroupId);
            try {
                await axios.post(`${GITLAB_API_URL}/projects/${project_id}/approval_rules`, {
                    name: 'AWS Peer Review',
                    approvals_required: 1,
                    rule_type: 'regular',
                    protected_branch_ids: [awsMasterBranchId],
                    applies_to_all_protected_branches: false,
                    branches: ['aws_master'],
                    group_ids: [subgroupGroupId]
                }, { headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN } });
                console.log('✅ Approval rule "AWS Peer Review" added to aws_master');
            } catch (err) {
                console.error('❌ Failed to set approval rule for aws_master:', err.response?.data || err.message);
            }
        }

        const protectedBranches = await axios.get(`${GITLAB_API_URL}/projects/${project_id}/protected_branches`, {
            headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN }
        });
        console.log('✅ Final protected branches:', protectedBranches.data.map(b => b.name));

        res.json({
            message: 'GitLab project created and initialized with template!',
            project_url: projectResp.data.web_url
        });

    } catch (error) {
        console.error('❌ Error creating GitLab project:', error.response?.data || error.message);
        try { await fs.remove(tmpDir); } catch (_) {}
        res.status(500).json({ error: 'Failed to create GitLab project' });
    }
});

app.listen(port, () => {
    console.log(`GitLab Repo Creator backend running on port ${port}`);
});

