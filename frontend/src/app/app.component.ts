import { Component, OnInit } from '@angular/core';
import { HttpClient, HttpClientModule } from '@angular/common/http';
import { FormBuilder, FormGroup, Validators, FormsModule, ReactiveFormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ReactiveFormsModule,
    HttpClientModule,
    MatProgressSpinnerModule
  ],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent implements OnInit {

  form: FormGroup;
  createdProjectUrl: string | null = null;
  progress: number = 0;

  subgroups: Array<{ label: string; value: string }> = [];

  technologies = ['Go', 'Java', 'Javascript'];

  artifactTypesByTechnology: Record<string, string[]> = {
    Go: ['Image', 'Library'],
    Java: ['Image', 'Library', 'Kjar'],
    Javascript: ['Image', 'Library']
  };

  artifactTypes: string[] = [];

  constructor(private fb: FormBuilder, private http: HttpClient) {
    this.form = this.fb.group({
      projectName: ['', Validators.required],
      subgroup: ['', Validators.required],
      technology: ['', Validators.required],
      artifactType: ['', Validators.required],
      ownerInfo: ['']
    });
  }

  ngOnInit() {
    this.loadSubgroups();
  }

  /**
   * Use relative API paths (NO leading slash)
   * This makes the app work at:
   *   /
   *   /git-repo
   *   /git-repo/
   *   /some/other/path/
   * Regardless of hostname or domain.
   */
  loadSubgroups() {
    this.http.get<any[]>('api/config/subgroups').subscribe(
      data => {
        this.subgroups = data;
      },
      error => {
        console.error('Failed to load subgroups', error);
        alert('Error loading subgroups');
      }
    );
  }

  onTechnologyChange(selectedTech: string) {
    this.artifactTypes = this.artifactTypesByTechnology[selectedTech] || [];
    this.form.controls['artifactType'].setValue('');
  }

  /**
   * API call uses "api/create_repo" (relative)
   * Works behind:
   *  - Istio VirtualService
   *  - OpenShift Route
   *  - LoadBalancer
   *  - Any reverse proxy
   */
  submitForm() {
    if (this.form.valid) {
      this.progress = 10;

      this.http.post('api/create_repo', this.form.value).subscribe(
        (response: any) => {
          this.progress = 100;
          console.log('Project created:', response.project_url);
          this.createdProjectUrl = response.project_url;
        },
        (error) => {
          this.progress = 0;
          console.error('Error creating project:', error);
          alert('Error: ' + (error.error?.error || 'Unknown error'));
        }
      );

      const interval = setInterval(() => {
        if (this.progress < 95) {
          this.progress += 5;
        } else {
          clearInterval(interval);
        }
      }, 800);

    } else {
      alert('Please fill all required fields.');
    }
  }

  resetForm() {
    this.form.reset();
    this.createdProjectUrl = null;
    this.artifactTypes = [];
    this.progress = 0;
  }
}

