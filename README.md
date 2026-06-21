# Shutter

A [Lumiverse](https://github.com/prolix-oc/Lumiverse) extension that provides a quick-access widget and automation layer for native ImageGen with configurable inline insertion behaviour.

## Summary

Shutter adds a floating widget and an input bar action that let you trigger Lumiverse's native ImageGen with a single click. It calls Lumiverse's native ImageGen routes and uses the user's existing native ImageGen settings. 

What happens after generation depends on how ImageGen is configured:

- **Preview only and Set as background** — Images are inserted into the last message in the chat, resolved at the moment of insertion. By default Shutter appends a new image, but it can also replace the most recent Shutter image when configured or selected. Shutter only ever acts on the newest message and never reaches further back. Shutter either shows a modal asking whether to insert the generated image, or auto-inserts it, depending on your **After Generate** setting. Shutter does not set the generated image as an active background when 'Set as background' is selected. Functionally, Shutter treats these two generations the same. For Shutter workflows, **Preview only** is recommended.
- **Insert into chat / Attach to last message** — ImageGen handles image placement natively, so Shutter has nothing more to do. Shutter auto-generate is skipped in these modes.

When Shutter shows the ask-to-insert modal, you can also choose **Regenerate Image** to create a new image from the same resolved positive and negative prompts, or **Rebuild Prompt** to restart the normal Shutter generation flow from the original chat/message context. Tick **Replace existing image** to swap out the last Shutter image in the message instead of appending another.

Long-press or right-click the floating widget to open the advanced menu for the last message: **Append** a new image, **Replace** the last Shutter image, **Remove** the last Shutter image, or **Remove All** Shutter images from the last message.

Images inserted by Shutter are tagged `![shutter]` in the message markdown so they can be identified. By default these tags are stripped from the prompt before it is sent to the model — see **Remove Image Tags from Context** below. The image remains visible in chat through Lumiverse's viewer, but Shutter never sends the image itself as multimodal context.

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
- **Force Generation** — always generate regardless of scene changes, matching Lumiverse’s native **Force Generate** option in the ImageGen panel. When off, generation respects the scene change threshold. 

# The following settings apply only when Shutter handles insertion. They have no effect when ImageGen is set to Insert into Chat or Attach to Last Message.

- **Remove Image Tags from Context** — Controls only the `![shutter](...)` Markdown text. When on (the default), those tags are removed from prompts sent to the LLM while the image remains visible in chat. When off, the tags remain in the prompt. Shutter does not send the image itself as multimodal context in either mode.
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

## CSS Snippet
Tiny little CSS snippet for centring images inserted into messages if you prefer that to the default left align. 

If you're using Minimal chat layout, replace `BubbleMessage` with `MinimalMessage`

```
[data-component="BubbleMessage"] p:has(img[alt="shutter"]) {
  text-align: center !important;
}
```

## Compatibility

Shutter 1.0.5 requires Lumiverse 1.0.4 or newer.

### Compatibility notes

**Force Generation** exposes Lumiverse’s native ImageGen force-generate behaviour; Shutter does not implement its own scene-change logic. The setting is included because Shutter v1.0.0 always triggered native ImageGen with force generation enabled, and it defaults to on to preserve that behaviour. Turn it off if you want generation to respect Lumiverse's scene-change threshold.

## Permissions

| Permission | Why |
|---|---|
| `chat_mutation` | Append, replace, or remove Shutter image markdown in chat messages when inline insertion or cleanup is needed. |
| `ui_panels` | Render Shutter's settings UI and quick-access controls. |
| `interceptor` | Strip Shutter image tags from the prompt before it reaches the model when "Remove Image Tags from Context" is on. |

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
