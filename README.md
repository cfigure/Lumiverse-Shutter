# Shutter

A Lumiverse (https://github.com/prolix-oc/Lumiverse) extension that provides quick-access image generation for ImageGen with configurable insert behaviour.

## Summary

Shutter adds a floating button and an input bar action that let you trigger image generation with a single click. When you press either button, Shutter calls Lumiverse's ImageGen API for the active chat. 

What happens after generation depends on how ImageGen is configured:

- **Preview only and Set as background** - Messages are added to the last message in the chat. Shutter either shows a modal asking whether to insert the generated image, or auto-inserts it, depending on your **After Generate** setting. Shutter does not set the generated image as an active background when 'Set as background' is selected. Functionally, Shutter treats these two generations the same, my recommendation would be to leave it on 'Preview only', but both work. 
- **Insert into chat** — Press the button, and ImageGen creates the message with the image attached natively, so there's nothing more to do.

Images inserted by Shutter are tagged `![shutter]` in the message markdown so they can be identified. A regex script (included in the GitHub repo) can be imported to remove these tags and images before they're sent to the model.

### Auto Generate

Shutter can automatically trigger image generation after AI responses. Auto-generate is skipped when ImageGen is set to 'Insert into chat' mode.

There are three auto-generate modes:

- **Every message** — generates after every AI response
- **Every X messages** — generates after a fixed number of AI responses (e.g. every 3rd message)
- **Random interval** — generates after a random number of AI responses within a configurable range (e.g. between 3 and 7 messages)

The counter resets after any generation, whether manual or automatic. Auto-generate has its own **After Auto Generate** setting so you can control its behaviour independently from manual triggers. Error modals are suppressed for auto-generated images to avoid interrupting the conversation flow.

## Settings

- **Floating Button** — show a quick-access generate button on screen
- **Widget Size** — size of the floating button (Small 44px / Medium 56px / Large 72px)
- **Widget Style** — icon style for the floating button (Colour / Monochrome)
- **Toast on Insert** — show a notification when an image is inserted into a message
- **After Generate** — what to do after a manual generation (ask to insert / auto insert)

### Auto Generate Settings

- **Mode** — Off / Every message / Every X messages / Random interval
- **Interval** — number of AI messages between generations (when mode is "Every X messages")
- **Random Range** — min and max AI messages between generations (when mode is "Random interval")
- **After Auto Generate** — what to do after an automatic generation (auto insert / ask to insert)

## Compatibility

Shutter requires Lumiverse on the `staging` branch at commit [`1f7c821`](https://github.com/prolix-oc/Lumiverse/commit/1f7c8215c246d070c3a1e80a989b1aa4792cf61c) or later.

## Permissions

| Permission | Why |
|---|---|
| `chats` | Resolve the active chat for generation |
| `chat_mutation` | Append image markdown to message content |
| `ui_panels` | Optional floating widget button |
| `generation` | Trigger ImageGen for the active chat |

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