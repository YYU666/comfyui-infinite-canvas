# CPU 局部水印修补

runtime 原有 spatial-delogo 算法独立移植，预设 video_local_repair，视频输入端口 video。repairSettings 含 schemaVersion:1、rect{x,y,width,height}、start、end；比例选区限画面 15%，实际边缘留至少 2 px。仅限最长 120 秒、1–60 FPS、偶数尺寸最高 4096、输入及输出 512 MiB。不会下载模型或提交 ComfyUI。

原片/遮罩/修补三种 CPU 预览和正式导出沿用 runtime。空间插值可能模糊运动衣物，H.264 编码会影响选区外像素；音频包直接复制并校验。页面先用 revision 提交成片，再持久化 checkpoint 并读回核对，最后暴露 done；此移植额外持久化最终状态。当前输入或参数改变后旧成片会标记过期，下游拒绝使用。

本分支依赖 E1 + 节奏 + chroma stack。补充统一的 root 切换保护和 commit 锁，不触碰用户当前画布。真实 FFmpeg 验证只使用 TemporaryDirectory 内合成素材，验证修补区域变化、帧时间与原声音频包、预览和 CAS；并非真实人物素材效果验收。
