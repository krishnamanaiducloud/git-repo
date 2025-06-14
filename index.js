const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const path = require('path');  // 🚀 Required to serve static files
const app = express();
require('dotenv').config();

const port = process.env.PORT || 3000;

app.use(bodyParser.json());

// 🚀 Serve Angular UI from /public
app.use(express.static(path.join(__dirname, 'public/browser')));

// 🚀 Fallback route to support Angular routing (if needed)
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/browser', 'index.html'));
});

const GITLAB_API_URL = process.env.GITLAB_API_URL || 'https://gitlab.example.com/api/v4';
const GITLAB_TOKEN = process.env.GITLAB_TOKEN;

const namespaceMap = JSON.parse(process.env.NAMESPACE_MAP);
const templateMap = JSON.parse(process.env.TEMPLATE_MAP);

app.post('/api/create_repo', async (req, res) => {
    try {
        const { projectName, subgroup, technology, artifactType, ownerInfo } = req.body;

        const namespace_id = namespaceMap[subgroup];
        const template_name = `embark-${technology.toLowerCase()}-${artifactType.toLowerCase()}`;
        const template_project_id = templateMap[template_name];

        if (!namespace_id || !template_project_id) {
            return res.status(400).json({ error: 'Invalid subgroup or template mapping' });
        }

        const gitlabResponse = await axios.post(
            `${GITLAB_API_URL}/projects`,
            {
                name: projectName,
                path: projectName.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
                namespace_id: namespace_id,
                template_project_id: template_project_id,
                visibility: 'private',
                description: `Owner: ${ownerInfo}, Technology: ${technology}, Artifact: ${artifactType}`
            },
            {
                headers: {
                    'PRIVATE-TOKEN': GITLAB_TOKEN
                }
            }
        );

        res.json({
            message: 'GitLab project created successfully!',
            project_url: gitlabResponse.data.web_url
        });
    } catch (error) {
        console.error('Error creating GitLab project:', error.response?.data || error.message);
        res.status(500).json({ error: 'Failed to create GitLab project' });
    }
});

app.listen(port, () => {
    console.log(`GitLab Repo Creator backend running on port ${port}`);
});

