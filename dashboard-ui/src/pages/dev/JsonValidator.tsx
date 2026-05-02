import { ValidatorPage } from '@/components/ValidatorPage';

export default function JsonValidator() {
  return (
    <ValidatorPage
      kind="JSON"
      endpoint="json"
      title="JSON Validator"
      desc="High-End JSON-Validierung: erkennt Trailing-Commas, fehlende Quotes, Kommentare."
      accept=".json"
      placeholder='{ "key": "value" }'
    />
  );
}
