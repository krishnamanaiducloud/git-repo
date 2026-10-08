import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AppComponent } from './app.component';

describe('AppComponent', () => {
  let fixture: ComponentFixture<AppComponent>;
  let component: AppComponent;
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [provideHttpClient(), provideHttpClientTesting()]
    }).compileComponents();

    fixture = TestBed.createComponent(AppComponent);
    component = fixture.componentInstance;
    http = TestBed.inject(HttpTestingController);
    http.expectOne('api/config/subgroups').flush([{ label: 'Team A', value: 'team-a' }]);
    fixture.detectChanges();
  });

  afterEach(() => http.verify());

  it('renders the repository workflow', () => {
    expect(fixture.nativeElement.querySelector('h1')?.textContent).toContain('Provision a GitLab repository');
    expect(component.subgroups()).toEqual([{ label: 'Team A', value: 'team-a' }]);
  });

  it('validates project names before submission', () => {
    component.form.controls.projectName.setValue('invalid name');
    component.submitForm();

    expect(component.form.controls.projectName.invalid).toBe(true);
    expect(component.errorMessage()).toContain('highlighted fields');
  });

  it('updates artifact choices when technology changes', () => {
    component.form.controls.technology.setValue('Java');
    expect(component.artifactTypes()).toEqual(['Image', 'Library', 'Kjar']);
  });

  it('creates a repository using a relative, idempotent API request', () => {
    component.form.setValue({
      projectName: 'orders-api',
      subgroup: 'team-a',
      technology: 'Go',
      artifactType: 'Image',
      ownerInfo: 'Platform Team'
    });
    component.submitForm();

    const request = http.expectOne('api/create_repo');
    expect(request.request.method).toBe('POST');
    expect(request.request.headers.has('Idempotency-Key')).toBe(true);
    request.flush({ message: 'created', project_url: 'https://gitlab.example.com/team-a/orders-api' });

    expect(component.createdProjectUrl()).toBe('https://gitlab.example.com/team-a/orders-api');
    expect(component.isSubmitting()).toBe(false);
  });
});
