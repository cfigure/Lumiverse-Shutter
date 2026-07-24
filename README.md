# Shutter

A [Lumiverse](https://github.com/prolix-oc/Lumiverse) extension that adds quick-access and automated native ImageGen workflows, inline insertion controls, generation history, prompt metadata tools, and optional image layout controls.

## Summary

Shutter adds a floating widget and input bar action for triggering Lumiverse's native ImageGen. It uses your existing native ImageGen provider, prompt, scene-change, preview, and placement settings.

### Image placement

| Native ImageGen mode | Shutter behaviour |
|---|---|
| **Preview only** or **Set as background** | Shutter handles the result against the newest message. It can ask whether to insert the image or insert it automatically, and can append or replace the latest Shutter image. Shutter does not set an active background, so **Preview only** is recommended for Shutter workflows. |
| **Insert into chat** or **Attach to last message** | Native ImageGen handles placement. Shutter does not insert the result, and auto-generate is skipped in these modes. |

When Shutter shows the **Generate Image** modal, you can insert or replace the result, **Regenerate Image** from its resolved prompts, or **Rebuild Prompt** from the original chat context. Optional **Generation History** keeps results from the current prompt together so you can browse and reuse them. **Swipe & Keyboard Navigation** adds swipes on mobile and arrow keys on desktop.

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
| **Toast on Insert** | Show a notification when Shutter inserts an image. |
| **Remove Image Tags from Context** | Remove `![shutter](...)` text from prompts sent to the model. On by default. |
| **Remove Confirmation** | Never, Bulk Only, or Always ask before removing images. |

### Image handling

These settings apply only when Shutter handles placement. They do not affect **Insert into chat** or **Attach to last message** mode.

| Setting | Description |
|---|---|
| **After Generation** | Ask to insert or insert automatically after a manual generation. |
| **Default Widget Action** | Append a new image or replace the latest Shutter image. |
| **Generation History** | Keep images from the current prompt together in the Generate Image modal so you can browse and reuse them. |
| **Swipe & Keyboard Navigation** | Navigate generation history with swipes on mobile or arrow keys on desktop. |
| **Show Prompt in Lightbox** | Add a Prompt pill with Copy and View actions to Shutter images opened in Lumiverse's native image viewer. |
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
- **View Prompt** reads provider metadata embedded in the generated image. Shutter does not store a separate copy of the prompt.

## Compatibility

Shutter 1.0.7 requires Lumiverse 1.1.0 or newer.

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
