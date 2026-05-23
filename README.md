# Shutter

A [Lumiverse](https://github.com/prolix-oc/Lumiverse) extension that provides a quick-access widget and automation layer for native ImageGen with configurable inline insertion behaviour.

## Summary

Shutter adds a floating widget and an input bar action that let you trigger Lumiverse's native ImageGen with a single click. It calls Lumiverse's native ImageGen routes and uses the user's existing native ImageGen settings. 

What happens after generation depends on how ImageGen is configured:

- **Preview only and Set as background** — Images are appended to the last message in the chat. Shutter either shows a modal asking whether to insert the generated image, or auto-inserts it, depending on your **After Generate** setting. Shutter does not set the generated image as an active background when 'Set as background' is selected. Functionally, Shutter treats these two generations the same. For Shutter workflows, **Preview only** is recommended.
- **Insert into chat / Attach to last message** — ImageGen handles image placement natively, so Shutter has nothing more to do. Shutter auto-generate is skipped in these modes.

Images inserted by Shutter are tagged `![shutter]` in the message markdown so they can be identified. A [regex](Shutter-regex-scripts.json) script (included in the GitHub repo) can be imported to remove these tags and images before they're sent to the model.

### Auto Generate

Shutter can automatically trigger native ImageGen after AI responses. Auto-generate is skipped when ImageGen is set to "Insert into Chat" or "Attach to Last Message" mode, because native ImageGen already handles placement in those modes. Shutter's automation is intended for inline/background-style workflows where Shutter may need to append the generated image markdown itself.

There are three auto-generate modes:

- **Every message** — generates after every AI response
- **Every X messages** — generates after a fixed number of AI responses (e.g. every 3rd message)
- **Random interval** — generates after a random number of AI responses within a configurable range (e.g. between 3 and 7 messages)

The counter resets after any generation, whether manual or automatic. Auto-generate has its own **After Auto Generate** setting so you can control its behaviour independently from manual triggers. Error modals are suppressed for auto-generated images to avoid interrupting the conversation flow.

## Settings

- **Floating Widget** — show a quick-access generate button on screen
- **Widget Size** — size of the floating button (Small 44px / Medium 56px / Large 72px)
- **Widget Style** — icon style for the floating button (Colour / Monochrome)
- **Toast on Insert** — show a notification when an image is inserted into a message
- **Force Generation** — always generate regardless of scene changes, the same as Force Generate in the native ImageGen panel. When off, generation respects the scene change threshold. This is unlikely to be needed, but I have included it as Shutter v1.0.0 always went through as force generation, but practically it likely makes no difference. 
- **After Generate** — what to do after a manual generation. Skipped when ImageGen is set to "Insert into Chat" or "Attach to Last Message" (ask to insert / auto insert)

When "Preview Prompt Before Generating" is enabled in native ImageGen settings, Shutter shows its own prompt preview modal before manual generations. This mirrors the native preview flow because extensions cannot mount the native React prompt-preview component directly. You can review and edit the resolved prompt, re-run the parser, or generate directly.

### Auto Generate Settings

- **Mode** — Off / Every message / Every X messages / Random interval
- **Interval** — number of AI messages between generations (when mode is "Every X messages")
- **Random Range** — min and max AI messages between generations (when mode is "Random interval")
- **After Auto Generate** — what to do after an automatic generation (auto insert / ask to insert)
- **Preview Prompt on Auto** — show the prompt preview modal for auto-generated images. Requires "Preview Prompt Before Generating" to be enabled in native ImageGen settings.

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

Shutter requires Lumiverse 1.0.0 or newer.

## Permissions

| Permission | Why |
|---|---|
| `chat_mutation` | Append native ImageGen output markdown to the original assistant message when inline insertion is needed. |
| `ui_panels` | Render Shutter's settings UI and quick-access controls. |
| `generation` | Listen for Lumiverse generation lifecycle events so Shutter can optionally trigger native ImageGen after assistant replies. |

## Installation

Install from URL in **Settings → Extensions**:

```
https://github.com/cfigure/Lumiverse-shutter
```

Permissions are requested automatically on first load.

## License

Shutter is licensed under the [MIT License](LICENSE).

## Credits

Shutter icon "[shutter](https://loading.io/icon/vg8pdg)" provided by [loading.io](https://loading.io) under the [Loading.io BY Licence](https://loading.io/license/#by-license).
