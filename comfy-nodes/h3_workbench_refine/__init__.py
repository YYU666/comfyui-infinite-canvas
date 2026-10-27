"""Dual first-pass / refined window assembly for the H3 Workbench.

Keeps H3 Relay's native window contract and source audio. The extra state stays
inside StartLoop/EndLoop, so long videos export complete comparison clips rather
than leaking per-window SaveVideo outputs from the loop body.
"""

import importlib

import torch


class H3PortraitSkinMask:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "image": ("IMAGE",),
            "mode": (["front", "side", "back_body", "front_body"], {"default": "front"}),
        }}

    RETURN_TYPES = ("MASK", "IMAGE")
    RETURN_NAMES = ("skin_mask", "mask_preview")
    FUNCTION = "build"
    CATEGORY = "H3 Workbench"

    def build(self, image, mode="front"):
        height, width = image.shape[1:3]
        yy, xx = torch.meshgrid(
            torch.linspace(0, 1, height, device=image.device),
            torch.linspace(0, 1, width, device=image.device),
            indexing="ij",
        )
        red, green, blue = (image[0, :, :, channel] for channel in range(3))
        cb = 0.5019608 - 0.168736 * red - 0.331264 * green + 0.5 * blue
        cr = 0.5019608 + 0.5 * red - 0.418688 * green - 0.081312 * blue
        skin = (red > 85 / 255) & (red > green * 1.015) & (red > blue * 1.01) & (cb < 125 / 255) & (cr > 135 / 255)

        def ellipse(cx, cy, rx, ry):
            return ((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2 <= 1

        if mode == "front":
            region = ellipse(0.505, 0.46, 0.29, 0.28) | ellipse(0.505, 0.72, 0.23, 0.19) | ellipse(0.505, 0.89, 0.52, 0.17)
            protect = ellipse(0.505, 0.552, 0.13, 0.035)
        elif mode == "side":
            region = ellipse(0.45, 0.45, 0.28, 0.28) | ellipse(0.55, 0.72, 0.23, 0.20) | ellipse(0.58, 0.90, 0.54, 0.17)
            protect = ellipse(0.34, 0.53, 0.105, 0.035)
        else:
            region = torch.ones_like(skin)
            protect = torch.zeros_like(skin)
        mask = (skin & region & ~protect).to(image.dtype)
        preview = image.clone()
        preview[..., :3] = preview[..., :3] * (1 - mask[None, :, :, None] * 0.45) + mask[None, :, :, None] * torch.tensor([0.92, 0.22, 0.18], dtype=image.dtype, device=image.device) * 0.45
        return (mask, preview)


def _toolkit():
    return importlib.import_module("custom_nodes.h3-relay.h3_relay.toolkit")


class H3WorkbenchAppendRefinedWindow:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "refined_frames": ("IMAGE",),
                "first_pass_frames": ("IMAGE",),
                "window": ("H3_RELAY_WINDOW",),
            },
            "optional": {"previous": ("H3_RELAY_WINDOW_STATE",)},
        }

    RETURN_TYPES = ("H3_RELAY_WINDOW_STATE",)
    FUNCTION = "append"
    CATEGORY = "H3 Workbench"

    def append(self, refined_frames, first_pass_frames, window, previous=None):
        append_window = _toolkit().H3RelayAppendWindow()
        refined_state = append_window.append(refined_frames, window, previous=previous)[0]
        first_previous = previous.get("first_pass_state") if previous else None
        first_state = append_window.append(first_pass_frames, window, previous=first_previous)[0]
        refined_state["first_pass_state"] = first_state
        return (refined_state,)


class H3WorkbenchFinishRefinedWindows:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "state": ("H3_RELAY_WINDOW_STATE",),
                "audio_mode": (["source", "generated", "none"], {"default": "source"}),
            },
            "optional": {"source_audio": ("AUDIO",)},
        }

    RETURN_TYPES = ("IMAGE", "IMAGE", "AUDIO", "FLOAT", "STRING")
    RETURN_NAMES = ("refined_frames", "first_pass_frames", "audio", "fps", "report")
    FUNCTION = "finish"
    CATEGORY = "H3 Workbench"

    def finish(self, state, audio_mode="source", source_audio=None):
        first_state = state.get("first_pass_state")
        if first_state is None:
            raise ValueError("Missing first-pass window state")
        finish_windows = _toolkit().H3RelayFinishWindows()
        refined = finish_windows.finish(state, audio_mode=audio_mode, source_audio=source_audio)
        first = finish_windows.finish(first_state, audio_mode=audio_mode, source_audio=source_audio)
        refined_frames, audio, fps, report = refined["result"]
        first_frames = first["result"][0]
        ui = dict(refined.get("ui", {}))
        ui["h3_workbench_first_pass"] = first.get("ui", {}).get("h3_relay_report", [])
        return {"result": (refined_frames, first_frames, audio, fps, report), "ui": ui}


NODE_CLASS_MAPPINGS = {
    "H3WorkbenchAppendRefinedWindow": H3WorkbenchAppendRefinedWindow,
    "H3WorkbenchFinishRefinedWindows": H3WorkbenchFinishRefinedWindows,
    "H3PortraitSkinMask": H3PortraitSkinMask,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "H3WorkbenchAppendRefinedWindow": "H3 Workbench · Append Dual-Pass Window",
    "H3WorkbenchFinishRefinedWindows": "H3 Workbench · Finish Dual-Pass Windows",
    "H3PortraitSkinMask": "H3 Workbench · Front Portrait Skin Mask",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
