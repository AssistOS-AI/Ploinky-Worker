import path from 'node:path';
import fs from 'node:fs';
import {createWorkspace} from './workspace.mjs';
const INCLUDE=/\$\{\{([^{}\r\n]+)\}\}/g;
const VARIABLE=/\$\{([A-Za-z_$][\w$]*)\}/;
// Includes are compile-time constants. They never interpolate task state or
// model output. Paths start at the task workspace, then at the containing file.
export function expandTaskIncludes(task,{currentWorkingDirectory,onFile}={}){
 const result=structuredClone(task);
 if(!Object.values(result).some(p=>p.template?.includes('${{')))return result;
 if(!currentWorkingDirectory)throw new Error('Template file includes require currentWorkingDirectory');
 const workspace=createWorkspace(currentWorkingDirectory),cache=new Map();
 let total=0;
 function expand(text,parent,stack=[]){
  const expanded=text.replace(INCLUDE,(_,value)=>{
   const file=value.trim();
   if(!file||path.isAbsolute(file)||/[\0$]/.test(file))throw new Error('Template include requires a literal relative file path');
   const absolute=fs.realpathSync(workspace.resolve(path.resolve(parent,file)));
   if(stack.includes(absolute))throw new Error('Cyclic template include: '+file);
   if(stack.length>=16)throw new Error('Template include nesting limit exceeded');
   if(!cache.has(absolute)){
    const content=workspace.read(absolute);
    if(VARIABLE.test(content))throw new Error('Included prompt files must be constant: variable placeholder in '+file);
    onFile?.({path:workspace.relOf(absolute),content});cache.set(absolute,content);
   }
   const content=expand(cache.get(absolute),path.dirname(absolute),[...stack,absolute]);
   total+=content.length;if(total>2_000_000)throw new Error('Expanded template include size limit exceeded');
   return content;
  });
  if(expanded.includes('${{'))throw new Error('Malformed template file include');
  return expanded;
 }
 for(const phase of Object.values(result))if(phase.template!=null)phase.template=expand(phase.template,workspace.root);
 return result;
}
