# Shutter

A [Lumiverse](https://github.com/prolix-oc/Lumiverse) extension that adds quick-access and automated native ImageGen workflows, inline insertion controls, generation history, prompt metadata tools, and optional image layout controls.

## Summary

Shutter adds a floating widget and input bar action for triggering Lumiverse's native ImageGen. It uses your existing native ImageGen provider, prompt, scene-change, preview, and placement settings.

### Image placement

| Native ImageGen mode | Shutter behaviour |
|---|---|
| **Preview only** or **Set as background** | Shutter pins the newest message response when generation starts. It can ask whether to insert the image or insert it automatically, and can append or replace the latest Shutter image in that pinned response. Shutter does not set an active background, so **Preview only** is recommended for Shutter workflows. |
| **Insert into chat** or **Attach to last message** | Native ImageGen handles placement. Shutter does not insert the result, and auto-generate is skipped in these modes. |

When Shutter shows the **Image Generated** modal, you can insert or replace the result, **Regenerate Image** from its resolved prompts, or **Rebuild Prompt** from the original chat context. Optional **Generation History** saves every successful generation for the pinned message response and text swipe. Fresh widget generations, **Rebuild Prompt**, and **Regenerate Image** all append to the same history. The history is stored in compact, validated per-chat snapshots in Lumiverse per-user storage, so it survives restarts and follows the same account between desktop and mobile. **Swipe & Keyboard Navigation** adds swipes on mobile and arrow keys on desktop.

Long-press or right-click the floating widget to open actions for the newest message: **Append**, **Replace**, **Force Generate**, **View Prompt**, **Remove**, and **Remove All**. **Force Generate** appears only when native scene-change detection could otherwise skip the request.

Images inserted by Shutter use `![shutter](...)` markdown so the extension can identify them. By default, Shutter removes those tags from prompts sent to the model while leaving the images visible in chat. It does not send the image itself as multimodal context.

## Auto Generate

Shutter can trigger ImageGen after AI responses in three modes:

- **Every message**
- **Every X messages**
- **Random interval**

The counter resets after any manual or automatic generation. Auto-generate has its own post-generation behaviour and can optionally use the prompt preview flow. Errors are suppressed for automatic generations so they do not interrupt the conversation.

## Settings

### General

| Setting | Description |
|---|---|
| **Floating Widget** | Show the quick-access widget. |
| **Widget Size** | Small, Medium, Large, or XL. |
| **Widget Style** | Colour or Monochrome. |
| **Icon** | Aperture, Cherry Blossom, or Kitty Lotus. |
| **Toast on Insert and Replace** | Show a confirmation when Shutter inserts or replaces an image. |
| **Remove Image Tags from Context** | Remove `![shutter](...)` text from prompts sent to the model. On by default. |
| **Remove Confirmation** | Never, Bulk Only, or Always ask before removing images. |

### Image handling

These settings apply only when Shutter handles placement. They do not affect **Insert into chat** or **Attach to last message** mode.

| Setting | Description |
|---|---|
| **After Generation** | Ask to insert or insert automatically after a manual generation. |
| **Default Widget Action** | Append a new image or replace the latest Shutter image. |
| **Generation History** | Save and sync every generation and its submitted prompts for each message response and text swipe. There is no automatic generation-count cap. |
| **Swipe & Keyboard Navigation** | Navigate generation history with swipes on mobile or arrow keys on desktop. |
| **Clear Generation History** | Delete all saved Shutter history metadata for the account without deleting generated images or changing messages. |
| **Show Prompt in Lightbox** | Add a compact View History / View Prompt / Copy Prompt bar to Shutter images opened in Lumiverse's native image viewer. History is available without expanding the prompt. The expanded view can switch between metadata saved by Shutter and metadata embedded in the image. Copy Prompt copies only the positive and negative prompt from the selected source. |
| **Shutter Image Layout** | Leave Shutter image styling alone or enable scoped custom layout controls. |
| **Image Width** | Set inline Shutter image width from 1% to 100%. |
| **Image Alignment** | Align reduced-width images left, Center, or Right. |

### Auto Generate

| Setting | Description |
|---|---|
| **Mode** | Off, Every message, Every X messages, or Random interval. |
| **Interval** | Number of AI messages between generations in Every X mode. |
| **Random Range** | Minimum and maximum interval for Random mode. |
| **After Auto Generate** | Insert automatically or ask to insert. |
| **Preview Prompt on Auto** | Show prompt preview for automatic generations when native prompt preview is enabled. |

## Behaviour notes

- Shutter follows native ImageGen scene-change settings. It has no separate force-generation setting. Use native **Ignore Scene Change Detection** for always-force behaviour, or **Force Generate** from the widget menu for a single request.
- When native **Preview Prompt Before Generating** is enabled, Shutter shows its own editable prompt preview because extensions cannot mount Lumiverse's native React preview directly.
- Custom image layout is scoped to inline Shutter images in message content. It does not affect native attachments, uploads, pasted images, or other markdown images.
- Shutter saves the exact positive and negative prompts returned for each successful generation while **Generation History** is enabled. Prompt View prefers that durable record and also exposes provider metadata embedded in the image as a separate source when available. In the native lightbox, **View History** is always available beside **View Prompt** and **Copy Prompt**. The widget's **Image Prompt** modal follows Shutter's existing modal layout, with **Close**, **View History**, and **Copy Prompt** in its action row. The History viewer mirrors the Image Generated modal, offers **Close**, **View Prompt**, **Replace**, and **Insert**, and replaces the exact image that opened History rather than an unrelated last image. Insert or Replace closes the underlying native lightbox.
- Turning **Generation History** off stops new records but does not delete existing records. Use **Clear Generation History** for explicit deletion.
- If a generated image is later deleted from Lumiverse's gallery, Shutter keeps its saved prompt and provenance. History shows an **Image unavailable** placeholder and prevents inserting or replacing with the deleted asset.
- History uses two alternating snapshots per chat. A completed write is validated before it becomes the newest revision, so an interrupted or malformed write can fall back to the previous valid snapshot without creating a file per generation.
- Pre-release record-and-pointer data under `history/v1` is imported in place into compact chat snapshots. The source record files are left untouched after a verified import and are removed by Clear Generation History with their old epoch.
- Per-user history syncs between devices connected to the same Lumiverse deployment and account; it is not a cloud sync between unrelated Lumiverse servers.
- Deleting a message does not transfer its history to whichever message becomes last. Existing history for the newly exposed previous response remains associated with that response.

## Compatibility

Shutter 1.1.0 requires Lumiverse 1.1.0 or newer.

When upgrading:

- **Shutter Image Layout**, **Generation History**, and **Swipe & Keyboard Navigation** default to Off, so existing display and navigation behaviour is preserved.
- The old Shutter **Force Generation** setting was removed in 1.0.6. Native ImageGen settings now control scene-change behaviour.
- The legacy [regex script](Shutter-regex-scripts.json) is redundant on Shutter 1.0.5 or newer and is kept only for archive purposes.

## Permissions

| Permission | Why |
|---|---|
| `chat_mutation` | Append, replace, or remove Shutter image markdown in chat messages. |
| `ui_panels` | Render Shutter's settings and quick-access controls. |
| `interceptor` | Remove Shutter image tags from model context when enabled. |
| `app_manipulation` | Add prompt controls to Lumiverse's native image viewer. Optional; Shutter otherwise runs normally. |

## Installation

Install from URL in **Settings → Extensions**:

```
https://github.com/cfigure/Lumiverse-Shutter
```

Permissions are requested automatically on first load.

## License

Shutter is licensed under the [MIT License](LICENSE).

## Credits

Shutter icon "[shutter](https://loading.io/icon/vg8pdg)" provided by [loading.io](https://loading.io) under the [Loading.io BY Licence](https://loading.io/license/#by-license).
