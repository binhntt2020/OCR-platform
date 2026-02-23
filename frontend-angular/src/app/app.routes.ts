import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', loadComponent: () => import('./features/home/home.component').then(m => m.HomeComponent) },
  { path: 'chat', loadComponent: () => import('./features/chat/chat.component').then(m => m.ChatComponent) },
  { path: 'admin-rag', loadComponent: () => import('./features/admin-rag/admin-rag.component').then(m => m.AdminRagComponent) },
  { path: '**', redirectTo: '' }
];
