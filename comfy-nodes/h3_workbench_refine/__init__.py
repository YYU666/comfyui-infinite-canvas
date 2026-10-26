"""Dual first-pass / refined window assembly for the H3 Workbench.

Keeps H3 Relay's native window contract and source audio. The extra state stays
inside StartLoop/EndLoop, so long videos export complete comparison clips rather
than leaking per-window SaveVideo outputs from the loop body.
"""

import importlib


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
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "H3WorkbenchAppendRefinedWindow": "H3 Workbench · Append Dual-Pass Window",
    "H3WorkbenchFinishRefinedWindows": "H3 Workbench · Finish Dual-Pass Windows",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
