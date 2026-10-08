import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { finalize, timeout } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

interface SubgroupOption {
  label: string;
  value: string;
}

interface CreateRepositoryResponse {
  message: string;
  project_url: string;
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [ReactiveFormsModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AppComponent {
  private readonly fb = inject(FormBuilder);
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);

  readonly form = this.fb.nonNullable.group({
    projectName: [
      '',
      [
        Validators.required,
        Validators.minLength(2),
        Validators.maxLength(63),
        Validators.pattern(/^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9])$/)
      ]
    ],
    subgroup: ['', Validators.required],
    technology: ['', Validators.required],
    artifactType: ['', Validators.required],
    ownerInfo: ['', Validators.maxLength(200)]
  });

  readonly subgroups = signal<SubgroupOption[]>([]);
  readonly artifactTypes = signal<string[]>([]);
  readonly createdProjectUrl = signal<string | null>(null);
  readonly isSubmitting = signal(false);
  readonly isLoadingConfig = signal(true);
  readonly errorMessage = signal<string | null>(null);

  readonly technologies = ['Go', 'Java', 'Javascript'] as const;
  readonly artifactTypesByTechnology: Readonly<Record<string, readonly string[]>> = {
    Go: ['Image', 'Library'],
    Java: ['Image', 'Library', 'Kjar'],
    Javascript: ['Image', 'Library']
  };

  constructor() {
    this.loadSubgroups();
    this.form.controls.technology.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((technology) => {
        this.artifactTypes.set([...(this.artifactTypesByTechnology[technology] ?? [])]);
        this.form.controls.artifactType.setValue('');
      });
  }

  loadSubgroups(): void {
    this.isLoadingConfig.set(true);
    this.errorMessage.set(null);
    this.http
      .get<SubgroupOption[]>('api/config/subgroups')
      .pipe(timeout(10_000), finalize(() => this.isLoadingConfig.set(false)))
      .subscribe({
        next: (data) => this.subgroups.set(data),
        error: () => {
          this.subgroups.set([]);
          this.errorMessage.set('Repository configuration could not be loaded. Retry or contact Platform Engineering.');
        }
      });
  }

  submitForm(): void {
    this.errorMessage.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      this.errorMessage.set('Review the highlighted fields before creating the repository.');
      this.focusFirstInvalidControl();
      return;
    }

    this.isSubmitting.set(true);
    this.http
      .post<CreateRepositoryResponse>('api/create_repo', this.form.getRawValue(), {
        headers: { 'Idempotency-Key': crypto.randomUUID() }
      })
      .pipe(timeout(300_000), finalize(() => this.isSubmitting.set(false)))
      .subscribe({
        next: (response) => {
          const projectUrl = this.validHttpUrl(response.project_url);
          if (!projectUrl) {
            this.errorMessage.set('The repository was created, but GitLab returned an invalid project link.');
            return;
          }
          this.createdProjectUrl.set(projectUrl);
        },
        error: (error: { error?: { error?: string }; name?: string }) => {
          const message = error.name === 'TimeoutError'
            ? 'Repository creation is taking longer than expected. Check GitLab before retrying to avoid a duplicate request.'
            : error.error?.error || 'Repository creation failed. Your form has been preserved so you can retry.';
          this.errorMessage.set(message);
        }
      });
  }

  resetForm(): void {
    this.form.reset();
    this.artifactTypes.set([]);
    this.createdProjectUrl.set(null);
    this.errorMessage.set(null);
  }

  fieldInvalid(name: keyof typeof this.form.controls): boolean {
    const control = this.form.controls[name];
    return control.invalid && (control.dirty || control.touched);
  }

  private focusFirstInvalidControl(): void {
    queueMicrotask(() => {
      document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    });
  }

  private validHttpUrl(value: string): string | null {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
    } catch {
      return null;
    }
  }
}
