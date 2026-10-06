// Provider/model capabilities are configuration data, never task-specific rules.
export function modelBudget(config,tier,request={}){
 const entry=config.tiers?.[tier]?.[0];
 const provider=entry?.upstream??entry?.provider,model=entry?.model;
 const limits=config.providers?.[provider]?.modelLimits?.[model];
 if(!limits)return null;
 const positive=(value,name)=>{if(!Number.isSafeInteger(value)||value<1)throw Error(`Invalid model ${name} for ${provider}/${model}`);return value;};
 const contextTokens=positive(limits.contextTokens,'contextTokens');
 const maxOutputTokens=positive(limits.maxOutputTokens,'maxOutputTokens');
 const requested=request.maxTokens??config.taskExecution?.request?.maxTokens??limits.defaultOutputTokens??maxOutputTokens;
 const outputReserveTokens=positive(requested,'output token reserve');
 if(outputReserveTokens>maxOutputTokens||outputReserveTokens>=contextTokens)throw Error(`Requested output budget exceeds model limits for ${provider}/${model}`);
 return {provider,model,contextTokens,maxOutputTokens,outputReserveTokens,inputBudgetTokens:contextTokens-outputReserveTokens,source:limits.source??null,verifiedAt:limits.verifiedAt??null};
}
// UTF-8 byte length is a conservative bound for byte-based tokenizers, not an
// exact token count. Include prompt, batch envelope, IDs and message overhead.
export const conservativeTokens=prompt=>Buffer.byteLength(prompt,'utf8')+64;
