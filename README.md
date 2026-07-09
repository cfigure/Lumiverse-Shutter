# Shutter

A [Lumiverse](https://github.com/prolix-oc/Lumiverse) extension that provides a quick-access widget and automation layer for native ImageGen with configurable inline insertion behaviour, optional inline image layout controls, and metadata-only prompt labels for Shutter images.

## Summary

Shutter adds a floating widget and an input bar action that let you trigger Lumiverse's native ImageGen with a single click. It calls Lumiverse's native ImageGen routes and uses the user's existing native ImageGen settings. 

What happens after generation depends on how ImageGen is configured:

- **Preview only and Set as background** — Images are inserted into the last message in the chat, resolved at the moment of insertion. By default Shutter appends a new image, but it can also replace the most recent Shutter image when configured or selected. Shutter only ever acts on the newest message and never reaches further back. Shutter either shows a modal asking whether to insert the generated image, or auto-inserts it, depending on your **After Generate** setting. Shutter does not set the generated image as an active background when 'Set as background' is selected. Functionally, Shutter treats these two generations the same. For Shutter workflows, **Preview only** is recommended.
- **Insert into chat / Attach to last message** — ImageGen handles image placement natively, so Shutter has nothing more to do. Shutter auto-generate is skipped in these modes.

When Shutter shows the ask-to-insert modal, you can also choose **Regenerate Image** to create a new image from the same resolved positive and negative prompts, or **Rebuild Prompt** to restart the normal Shutter generation flow from the original chat/message context. Tick **Replace existing image** to swap out the last Shutter image in the message instead of appending another.

Long-press or right-click the floating widget to open the advanced menu for the last message: **Append** a new image, **Replace** the last Shutter image, **Force Generate** to bypass the scene-change check for a single press, **View Prompt** to read the last Shutter image's generation prompt in a modal, **Remove** the last Shutter image, or **Remove All** Shutter images from the last message. View Prompt reads the prompt from the image's embedded provider metadata on request (nothing is stored), resolves the image through the message markdown via the Chat Mutation permission — so it works even when the message isn't currently rendered — and is available whether or not "Show Prompt in Lightbox" is enabled or the App Manipulation permission is granted. Images without readable metadata report so in the modal. Force Generate mirrors the native ImageGen panel's button of the same name, and only appears when it would do something — scene prompt mode with native **Ignore Scene Change Detection** off. In custom and parsed prompt modes the scene check never runs (every press already generates), and with Ignore Scene Change Detection on every press is already forced, so the item is hidden in those configurations.

Images inserted by Shutter are tagged `![shutter]` in the message markdown so they can be identified. By default these tags are stripped from the prompt before it is sent to the model — see **Remove Image Tags from Context** below. The image remains visible in chat through Lumiverse's viewer, but Shutter never sends the image itself as multimodal context.

Shutter can also optionally manage the display size and alignment of its own inline markdown images. This is off by default so existing custom CSS is not disturbed.

> **Legacy:** older Shutter versions shipped a [regex](Shutter-regex-scripts.json) script to strip these tags manually. That's now built in and the script is redundant on Shutter 1.0.5+. It's kept in the repo only for archive purposes; if you imported it previously, you can delete it.

### Auto Generate

Shutter can automatically trigger native ImageGen after AI responses. Auto-generate is skipped when ImageGen is set to "Insert into Chat" or "Attach to Last Message" mode, because native ImageGen already handles placement in those modes. Shutter's automation is intended for inline/background-style workflows where Shutter may need to insert the generated image markdown itself.

There are three auto-generate modes:

- **Every message** — generates after every AI response
- **Every X messages** — generates after a fixed number of AI responses (e.g. every 3rd message)
- **Random interval** — generates after a random number of AI responses within a configurable range (e.g. between 3 and 7 messages)

The counter resets after any generation, whether manual or automatic. Auto-generate has its own **After Auto Generate** setting so you can control its behaviour independently from manual triggers. Error modals are suppressed for auto-generated images to avoid interrupting the conversation flow.

## Settings Overview

- **Floating Widget** — Show a quick-access generate widget on screen
- **Widget Size** — Size of the floating button (Small / Medium / Large / XL)
- **Widget Style** — Icon style for the floating button (Colour / Monochrome)
- **Icon** — Choose the icon used for the floating widget and input bar action (Aperture / Cherry Blossom / Kitty Lotus)
- **Toast on Insert** — Show a notification when an image is inserted into a message

Shutter has no force-generation setting of its own: generation follows your native ImageGen settings, including the **Ignore Scene Change Detection** toggle and the scene change threshold. In scene prompt mode, if the scene hasn't changed enough and Ignore Scene Change Detection is off, manual triggers show a brief "generation skipped" toast instead of generating (auto-generate skips silently and retries on the next AI response) — to generate anyway, use **Force Generate** in the widget's long-press menu. Custom and parsed prompt modes always generate, as they do natively.

> **Removed in 1.0.6:** the old **Force Generation** setting. It dated from Shutter 1.0.0, which always forced generation, and it contradicted Shutter's design of riding alongside native ImageGen settings. In practice it only ever had an effect in scene prompt mode with native **Ignore Scene Change Detection** off. If you relied on always-force behaviour, turn on **Ignore Scene Change Detection** in the native ImageGen panel, or use **Force Generate** in the widget's long-press menu per press.

The following settings apply only when Shutter handles insertion. They have no effect when ImageGen is set to Insert into Chat or Attach to Last Message.

- **Remove Image Tags from Context** — Controls only the `![shutter](...)` Markdown text. When on (the default), those tags are removed from prompts sent to the LLM while the image remains visible in chat. When off, the tags remain in the prompt. Shutter does not send the image itself as multimodal context in either mode.
- **Shutter Image Layout** — Optional layout controls for inline Shutter markdown images. Off by default. When set to Custom, Shutter injects scoped CSS for `img[alt="shutter"]` inside message content only.
- **Image Width** — Width of inline Shutter images as a typeable percentage of the message area. Values are clamped from 1% to 100% and support decimal values.
- **Image Alignment** — Left, Center, or Right alignment for inline Shutter images when the width is below 100%.
- **Show Prompt in Lightbox** — When on (off by default), opening a Shutter image in the native image viewer shows a compact **Prompt** pill directly beneath the image, with **Copy** and **View** actions when the generation prompt (and negative prompt) can be read from provider metadata embedded in the image. **View** expands the prompt into a panel below the image — sized relative to the image and screen so the artwork stays the focus — and **Collapse** returns to the pill; the **✕** hides it until the viewer is reopened. The image only gives up space when it genuinely has none to spare, and never resizes while the viewer is closing. Requires the `app_manipulation` permission; without it the switch is disabled and the viewer is left untouched. A1111/Forge and NovelAI embeds are read directly; ComfyUI workflow text is shown best-effort. Images without readable metadata show no label. Only images Shutter inserted (identified by their `![shutter]` tag) are decorated; native ImageGen attachments are left alone. Shutter does not store prompt history for this feature.
- **After Generation** — What to do after a manual generation (ask to insert / auto insert)
- **Default Widget Action** — What pressing the widget or the input bar action does. Append inserts a new image, Replace swaps out the last Shutter image first. If no image is inserted, Replace acts as normal Append (append / replace)
- **Remove Confirmation** — When to ask before removing images via the advanced menu (never / bulk only / always)

When "Preview Prompt Before Generating" is enabled in native ImageGen settings, Shutter shows its own prompt preview modal before manual generations. This mirrors the native preview flow because extensions cannot mount the native React prompt-preview component directly. You can review and edit the resolved prompt, re-run the parser, or generate directly.

### Auto Generate Settings

- **Mode** — Off / Every message / Every X messages / Random interval
- **Interval** — Number of AI messages between generations (when mode is "Every X messages")
- **Random Range** — Min and max AI messages between generations (when mode is "Random interval")
- **After Auto Generate** — What to do after an automatic generation (auto insert / ask to insert)
- **Preview Prompt on Auto** — Show the prompt preview modal for auto-generated images. Requires "Preview Prompt Before Generating" to be enabled in native ImageGen settings.

When "Preview Prompt Before Generating" is enabled in native ImageGen settings and **Preview Prompt on Auto** is turned on, Shutter will also show the prompt preview modal for auto-generated images.

## Inline Image Layout

Shutter 1.0.6 includes built-in layout controls for inline Shutter images, so a custom stylesheet is no longer needed for basic resizing or alignment.

Set **Shutter Image Layout** to **Custom** to choose a width percentage and left, center, or right alignment. The setting only targets inline Shutter markdown images (`![shutter](...)`) inside message content. Native ImageGen attachments, pasted images, uploaded images, and non-Shutter markdown images are not changed.

Leave this setting **Off** if you already use custom CSS for Shutter images.

## Compatibility

Shutter 1.0.6 requires Lumiverse 1.0.4 or newer.

### Compatibility notes

**Force generation** (removed in 1.0.6) — Shutter no longer sends its own force-generation flag and does not implement any scene-change logic of its own; the native ImageGen **Ignore Scene Change Detection** setting and scene-change threshold govern all Shutter-triggered generations. Upgrading from 1.0.5 or earlier removes the setting automatically; the stale key in stored settings is cleaned up on the next settings change.

**Shutter Image Layout** (new in 1.0.6) — Layout controls default to Off, so upgrading will not override existing custom CSS. When enabled, the generated CSS is scoped to inline Shutter markdown images in message content.

## Permissions

| Permission | Why |
|---|---|
| `chat_mutation` | Append, replace, or remove Shutter image markdown in chat messages when inline insertion or cleanup is needed. |
| `ui_panels` | Render Shutter's settings UI and quick-access controls. |
| `interceptor` | Strip Shutter image tags from the prompt before it reaches the model when "Remove Image Tags from Context" is on. |
| `app_manipulation` | Add the generation-prompt pill to the native image viewer when "Show Prompt in Lightbox" is on. Optional — Shutter runs without it; the lightbox pill is simply unavailable (View Prompt in the widget menu still works). |

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
