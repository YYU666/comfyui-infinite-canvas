"""Versioned defaults; explicit parameters always override this recipe."""
AI_LOWPOLY_PRESET = {
    'id': 'meshanything-v2-demo-v1',
    'label': '标准减面 v1',
    'version': 1,
    'sourceJobId': 'n3d_c5585a492d454bf0a87ed641f64e7b9d',
    'checkpointSha256': 'c7cb232f2dcede0e03921f373e659a1415bb2fb852faf1ad271803450d878ad0',
    'parameters': {'conditioningProfile': 'legacy_world_fp16', 'inputSeed': 0, 'seed': 0, 'sampling': False},
}
AI_LOWPOLY_DEFAULTS = AI_LOWPOLY_PRESET['parameters']
