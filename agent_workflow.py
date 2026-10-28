from __future__ import annotations


RATIOS = {"16:9": (832, 480), "9:16": (480, 832), "1:1": (640, 640), "4:3": (736, 544), "3:4": (544, 736), "21:9": (960, 416)}
SCALES = {"480P": 1, "720P": 1.5, "1080P": 2.25}


def dimensions(ratio="16:9", resolution="480P"):
    width, height = RATIOS.get(ratio, RATIOS["16:9"])
    scale = SCALES.get(resolution, 1)
    snap = lambda value: max(32, round(value * scale / 32) * 32)
    return snap(width), snap(height)


def frames(seconds=5):
    return max(5, min(362, 5 + 17 * round((float(seconds) * 24 - 5) / 17)))


def build_video_workflow(options, references=None):
    """Server-side equivalent of the canvas H3 text/reference video workflow."""
    references = references or []
    width, height = dimensions(options.get("ratio"), options.get("resolution"))
    turbo = options.get("turbo") is not False
    reference = bool(references)
    model = "minimax_h3_ref2va_pruned_int8_convrot.safetensors" if reference else "minimax_h3_fl2va_pruned_int8_convrot.safetensors"
    lora = "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors" if reference else "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors"
    conditioning = "MiniMaxH3ReferenceToVideo" if reference else "MiniMaxH3ImageToVideo"
    prompt = str(options.get("prompt") or "").strip()
    counters = {"image": 0, "video": 0, "audio": 0}
    for item in references:
        kind = item.get("kind", "image")
        counters[kind] = counters.get(kind, 0) + 1
        label = {"image": "Picture", "video": "Video", "audio": "Audio"}[kind]
        if item.get("title"):
            prompt = prompt.replace(f"@{item['title']}", f"<{label} {counters[kind]}>")
    inputs = {
        "clip": ["4", 0], "vae": ["5", 0], "prompt": prompt, "width": width, "height": height,
        "length": frames(options.get("duration", 5)),
    }
    if reference:
        inputs.update({"audio_vae": ["6", 0], "ref_image_size": options.get("refImageSize", "max")})
    graph = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": model, "weight_dtype": "default"}},
        "3": {"class_type": "MiniMaxH3SigmaShift", "inputs": {"model": ["2", 0] if turbo else ["1", 0], "shift_video": 12, "shift_audio": 3}},
        "4": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen3vl_32b_minimax_h3_int8_convrot.safetensors", "type": "minimax", "device": "default"}},
        "5": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_video_vae_int8_convrot.safetensors"}},
        "6": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_audio_vae_fp32.safetensors"}},
        "7": {"class_type": conditioning, "inputs": inputs},
        "8": {"class_type": "BasicGuider", "inputs": {"model": ["3", 0], "conditioning": ["7", 0]}},
        "9": {"class_type": "RandomNoise", "inputs": {"noise_seed": int(options.get("seed", 0))}},
        "10": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "res_multistep"}},
        "11": {"class_type": "BasicScheduler", "inputs": {"model": ["3", 0], "scheduler": "beta", "steps": (4 if reference else 8) if turbo else 20, "denoise": 1}},
        "12": {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": ["9", 0], "guider": ["8", 0], "sampler": ["10", 0], "sigmas": ["11", 0], "latent_image": ["7", 1]}},
        "13": {"class_type": "VAEDecode", "inputs": {"samples": ["12", 0], "vae": ["5", 0]}},
        "14": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["12", 0], "vae": ["6", 0]}},
        "15": {"class_type": "CreateVideo", "inputs": {"images": ["13", 0], "fps": 24, "audio": ["14", 0], "codec": "h264"}},
        "16": {"class_type": "SaveVideo", "inputs": {"video": ["15", 0], "filename_prefix": "video/H3_Workbench", "format": "mp4", "codec": "auto"}},
    }
    if turbo:
        graph["2"] = {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["1", 0], "lora_name": lora, "strength_model": 1}}
    auto = {"image": {}, "video": {}, "videoAudio": {}, "audio": {}}
    counters = {"image": 0, "video": 0, "audio": 0}
    for index, item in enumerate(references):
        kind = item.get("kind", "image")
        kind_index = counters[kind]
        counters[kind] += 1
        node_id = str(100 + index)
        if kind == "image":
            graph[node_id] = {"class_type": "LoadImage", "inputs": {"image": item["name"]}}
            auto["image"][f"ref_image_{kind_index}"] = [node_id, 0]
        elif kind == "video":
            graph[node_id] = {"class_type": "LoadVideo", "inputs": {"file": item["name"]}}
            component = str(200 + index)
            graph[component] = {"class_type": "GetVideoComponents", "inputs": {"video": [node_id, 0]}}
            auto["video"][f"ref_video_{kind_index}"] = [component, 0]
            auto["videoAudio"][f"ref_video_audio_{kind_index}"] = [component, 1]
        else:
            graph[node_id] = {"class_type": "LoadAudio", "inputs": {"audio": item["name"]}}
            auto["audio"][f"ref_audio_{kind_index}"] = [node_id, 0]
    if auto["image"]:
        inputs["ref_images"] = auto["image"]
    if auto["video"]:
        inputs["ref_videos"] = auto["video"]
    if auto["videoAudio"]:
        inputs["ref_video_audios"] = auto["videoAudio"]
    if auto["audio"]:
        inputs["ref_audios"] = auto["audio"]
    return graph
