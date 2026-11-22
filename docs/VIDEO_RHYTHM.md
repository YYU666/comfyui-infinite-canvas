# 视频节奏

依赖 E1 视频编辑的 FFmpeg 基础设施。恒定速度（video_speed）设置 speed 0.25–4 和 rhythmAudio preserve/stretch/mute；时间重映射（video_time_remap）设置 remapKeyframes，output/source 使用秒，支持 linear/easeIn/easeOut/easeInOut。源时间保持不变的片段形成定格，时间重映射输出静音。节点算法保持 runtime 实现。

输入接 v1，导出由本机 CPU 完成，结果经当前页面的项目 revision 保存到新素材。失败或取消保留旧成片；复制节点清理任务与输出身份。编辑器之间的连线在下次提交时读取上游最近导出。后台重启后任务需重新导出。

依赖新增 numpy==2.3.5，requirements.lock 使用官方发布文件哈希。自动测试只读取临时生成的合成视频，不代表真实用户素材效果已经验收。
