import { ToolStub } from './_ToolStub';

export default function Page() {
  return (
    <ToolStub
      title="Debug Tools"
      desc="Inspector, Heap-Snapshot, EventLoop-Lag."
      features={[
        "Heap-Snapshot Download",
        "EventLoop-Lag Histogramm",
        "GC-Statistiken",
        "Active-Handles / -Requests",
        "Test-Harness fuer einzelne Module"
      ]}
    />
  );
}
