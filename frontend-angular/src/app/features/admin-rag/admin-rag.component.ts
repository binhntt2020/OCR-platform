import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { DocsComponent } from '../../components/docs/docs.component';
import { PdfViewerComponent } from '../../components/pdf-viewer/pdf-viewer.component';
import { JsonEditorComponent } from '../../components/json-editor/json-editor.component';

@Component({
  selector: 'app-admin-rag',
  standalone: true,
  imports: [
    CommonModule,
    RouterLink,
    DocsComponent,
    PdfViewerComponent,
    JsonEditorComponent
  ],
  templateUrl: './admin-rag.component.html',
  styleUrl: './admin-rag.component.scss'
})
export class AdminRagComponent {
  title = 'Admin RAG';
  apiBase = 'http://localhost:8000/api/';
  docsCollapsed = false;

  toggleDocs(): void {
    this.docsCollapsed = !this.docsCollapsed;
  }
}
