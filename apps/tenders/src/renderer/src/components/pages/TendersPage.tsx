// Tenders page: tender list + RFP shredder (list view) or
// split-pane workspace (when a tender is open).
import { useTendersStore } from '../../store'
import { TenderList } from '../TenderList'
import { Workspace } from '../Workspace'

export function TendersPage() {
  const view = useTendersStore((s) => s.view)
  return view === 'workspace' ? <Workspace /> : <TenderList />
}
