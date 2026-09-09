from pathlib import Path

radar = Path('src/dashboard/routes/v2/radar.ts')
text = radar.read_text(encoding='utf-8')
load_import = "import { loadRadarPlayerDirectory } from '../../../modules/radar/playerDirectory';"
guid_import = "import { isValidBattleyeGuid } from '../../../utils/guid';"
if load_import in text and guid_import not in text:
    text = text.replace(load_import, f"{guid_import}\n{load_import}", 1)
radar.write_text(text, encoding='utf-8')
