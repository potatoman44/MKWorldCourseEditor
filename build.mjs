import * as esbuild from 'esbuild'; import fs from 'fs';
const r = await esbuild.build({ entryPoints:['src/main.js'], bundle:true, minify:true, format:'iife', write:false, target:'chrome110', legalComments:'eof' });
const js = r.outputFiles[0].text.replace(/<\/script/gi,'<\\/script');
const html = fs.readFileSync('src/index.html','utf8').replace('<script>/*APP*/</script>', ()=>'<script>'+js+'</script>');
fs.mkdirSync('dist',{recursive:true}); fs.writeFileSync('dist/MKWorld-Course-Editor.html', html); console.log(html.length);
