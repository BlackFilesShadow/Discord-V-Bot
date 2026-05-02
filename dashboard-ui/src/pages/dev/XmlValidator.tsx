import { ValidatorPage } from '@/components/ValidatorPage';

export default function XmlValidator() {
  return (
    <ValidatorPage
      kind="XML"
      endpoint="xml"
      title="XML Validator"
      desc="High-End XML-Validierung mit Zeile/Spalte und Auto-Fix-Vorschlag."
      accept=".xml"
      placeholder='<root><item id="1">Wert</item></root>'
    />
  );
}
