import { ToolStub } from './_ToolStub';

export default function Page() {
  return (
    <ToolStub
      title="Dashboard Status"
      desc="Express-Server, Sessions, aktive Sockets."
      features={[
        "Aktive HTTP-Sessions",
        "Socket.IO-Verbindungen pro Namespace",
        "Request-Latenz und Throughput",
        "Rate-Limit-Hits"
      ]}
    />
  );
}
