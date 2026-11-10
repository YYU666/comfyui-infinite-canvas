"""Fixed official vision profiles sharing one OpenAI-compatible chat protocol.

Capability declarations come from provider documentation, not paid inference tests.
Endpoints are immutable and redirect following is disabled by the API transport.
"""
from project_store import StoreError

PROFILES = {
 'qwen': {'id':'qwen','name':'千问 Qwen','endpoint':'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions','models':['qwen3-vl-plus'],'env':['QWEN_API_KEY','DASHSCOPE_API_KEY'],'defaultModel':'qwen3-vl-plus','extra':{'enable_thinking':False},'docs':'https://help.aliyun.com/zh/model-studio/json-mode'},
 'kimi': {'id':'kimi','name':'Kimi','endpoint':'https://api.moonshot.cn/v1/chat/completions','models':['kimi-k3.1-pro'],'env':['MOONSHOT_API_KEY','KIMI_API_KEY'],'defaultModel':'kimi-k3.1-pro','extra':{'reasoning_effort':'low'},'docs':'https://platform.moonshot.cn/docs/guide/use-kimi-vision-model'},
 'doubao': {'id':'doubao','name':'豆包 Doubao','endpoint':'https://ark.cn-beijing.volces.com/api/v3/chat/completions','models':['doubao-seed-2-1-pro-260915'],'env':['ARK_API_KEY','DOUBAO_API_KEY'],'defaultModel':'doubao-seed-2-1-pro-260915','extra':{'thinking':{'type':'disabled'}},'docs':'https://ark.volcengine.com/region:cn-beijing/docs/image-understanding'},
 'deepseek': {'id':'deepseek','name':'DeepSeek Flash（视觉）','endpoint':'https://api.deepseek.com/chat/completions','models':['deepseek-flash'],'env':['DEEPSEEK_API_KEY'],'defaultModel':'deepseek-flash','extra':{},'docs':'https://api-docs.deepseek.com/zh-cn/guides/vision'},
}


def profile_for(provider='qwen', model=None):
    if not isinstance(provider,str) or provider not in PROFILES:
        raise StoreError('UNSUPPORTED_VISION_PROVIDER','不支持的视觉供应商。只允许界面列出的官方配置。',400)
    profile=PROFILES[provider]
    chosen=model if model is not None else profile['defaultModel']
    if not isinstance(chosen,str) or chosen not in profile['models']:
        raise StoreError('UNSUPPORTED_VISION_MODEL','此模型未列入已核对的视觉能力名单；文本模型不能用于图片审查。',400)
    return profile,chosen


def build_chat_request(provider, model, prompt, content):
    profile,model=profile_for(provider,model)
    body={'model':model,'messages':[{'role':'system','content':prompt},{'role':'user','content':content}],'max_tokens':6000,'response_format':{'type':'json_object'},**profile['extra']}
    return profile['endpoint'],body


def public_profiles():
    return [{'id':p['id'],'name':p['name'],'models':p['models'],'defaultModel':p['defaultModel'],'visionSupported':True,'contractVerification':'official-docs-and-mocks','inferenceTested':False,'docs':p['docs']} for p in PROFILES.values()]
