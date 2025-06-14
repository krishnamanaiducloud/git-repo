import { ApplicationConfig, importProvidersFrom } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideAnimations } from '@angular/platform-browser/animations';
import { FormsModule, ReactiveFormsModule } from '@angular/forms';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter([]),
    provideHttpClient(withInterceptors([])),
    provideAnimations(),
    importProvidersFrom(FormsModule, ReactiveFormsModule, MatProgressSpinnerModule)
  ]
};

