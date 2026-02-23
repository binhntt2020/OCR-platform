import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { StructureNode } from '../../models/structure-node.model';

@Component({
  selector: 'app-structure-tree',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './structure-tree.component.html',
  styleUrl: './structure-tree.component.scss'
})
export class StructureTreeComponent {
  @Input() nodes: StructureNode[] = [];
  @Input() selectedNodeId: string | null = null;
  @Output() nodeSelected = new EventEmitter<StructureNode>();

  getDisplayTitle(node: StructureNode): string {
    return node.title || node.full_title || node.structure || '(Không có tiêu đề)';
  }

  onSelect(node: StructureNode): void {
    this.nodeSelected.emit(node);
  }

  trackByNodeId(_index: number, node: StructureNode): string {
    return node.node_id;
  }
}
