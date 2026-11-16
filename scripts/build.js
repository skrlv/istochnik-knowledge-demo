import {rm,mkdir,cp,writeFile} from 'node:fs/promises';
const root = new URL('../',import.meta.url);
const out = new URL('dist/',root);
await rm(out,{recursive:true,force:true});
await mkdir(out,{recursive:true});
for (const item of ['index.html','styles.css','favicon.svg','src','data']) await cp(new URL(item,root),new URL(item,out),{recursive:true});
await writeFile(new URL('.nojekyll',out),'');
console.log('Static artifact: dist/ (no server, queue or private data)');
