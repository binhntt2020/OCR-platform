import { ApplicationConfig, SecurityContext } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideMarkdown } from 'ngx-markdown';
import { MARKED_OPTIONS, MarkedOptions } from 'ngx-markdown';
import hljs from 'highlight.js';

import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(routes),
    provideHttpClient(),
    // Tắt sanitize để thẻ <a id="xxx"></a> trong .md render thành HTML thật (anchor ẩn), không hiện dạng chữ
    provideMarkdown({ sanitize: SecurityContext.NONE }),
    {
      provide: MARKED_OPTIONS,
      useValue: {
        gfm: true,
        breaks: true,
        // Allow HTML tags in markdown (needed for <a id="xxx"></a> anchor tags)
        // Note: marked.js by default allows HTML, but we need to ensure it's not sanitized
        highlight: (code: string, lang: string) => {
          if (lang && hljs.getLanguage(lang)) {
            try {
              return hljs.highlight(code, { language: lang }).value;
            } catch (err) {
              // Fallback to auto-detect
              return hljs.highlightAuto(code).value;
            }
          }
          // Auto-detect language
          return hljs.highlightAuto(code).value;
        }
      } as MarkedOptions
    }
  ]
};
