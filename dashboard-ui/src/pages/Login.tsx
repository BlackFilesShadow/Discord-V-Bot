import { Button } from '@/components/ui/Button';

export default function Login() {
  return (
    <div className="grid place-items-center h-full bg-bg">
      <div className="text-center space-y-8 p-10 rounded-2xl bg-bg-card border border-border max-w-md">
        <div>
          <h1 className="v-logo text-7xl font-extrabold leading-none">V</h1>
          <p className="text-muted text-sm mt-2">V-Bot Owner Dashboard</p>
        </div>
        <div className="space-y-3">
          <Button
            size="lg"
            className="w-full"
            onClick={() => { window.location.href = '/auth/login'; }}
          >
            Mit Discord anmelden
          </Button>
          <p className="text-xs text-muted">
            Du musst Owner mindestens einer Guild sein, in der V-Bot eingeladen ist.
          </p>
        </div>
      </div>
    </div>
  );
}
