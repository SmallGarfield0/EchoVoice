# EchoVoice Language Packs

The desktop client supports built-in language packs and user-imported community translations.

The current language selector/import/export UI is a development test panel. The product design target is to move these controls into a dedicated settings page later.

## File Format

```json
{
  "id": "community-locale",
  "name": "Community Locale",
  "strings": {
    "form.connect": "Connect"
  }
}
```

Rules:

1. `id` should be stable and unique.
2. `name` is shown in the language selector.
3. `strings` contains translation key/value pairs.
4. Missing keys fall back to English.
5. Imported language packs are stored locally in the desktop client.

## Export Template

In the current desktop development UI:

1. Open the right-side language development panel.
2. Click `Export template`.
3. Translate the generated JSON.
4. Import the translated JSON with `Import language`.

## Current Built-ins

- `zh-CN`
- `en-US`
