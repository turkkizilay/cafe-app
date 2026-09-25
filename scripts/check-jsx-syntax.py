"""Offline lexical JSX check plus Node syntax check; does not replace Vite/React."""
import re,pathlib,subprocess,sys
from jsx_scan import Scanner
class Lower(Scanner):
 def __init__(self,s):super().__init__(s);self.replacements=[]
 def lower(self,a,b):
  out=self.s[a:b]
  roots=[r for r in self.replacements if a<=r[0] and r[1]<=b and not any(a<=q[0]<r[0] and q[1]>=r[1] and q[1]<=b for q in self.replacements)]
  for x,y,t in sorted(roots,reverse=True):out=out[:x-a]+t+out[y-a:]
  return out
 def element(self,i):
  s=self.s;start=i;i+=1;parts=[]
  m=re.match(r'[\w.:-]+',s[i:]);tag=m[0] if m else '';i+=len(tag)
  def expr(i):
   a=i+1;end=self.code(a,'}');v=self.lower(a,end-1)
   if v.strip() and not re.fullmatch(r'\s*/\*.*?\*/\s*',v,re.S):parts.append(v)
   return end
  while i<len(s):
   if s.startswith('/>',i):
    end=i+2;self.replacements.append((start,end,'(['+','.join(parts)+'])'));return end
   if s[i]=='>':i+=1;break
   if s[i]=='{':i=expr(i);continue
   if s[i] in '\'"':i=self.string(i);continue
   i+=1
  while i<len(s):
   if s.startswith('</',i):
    end=s.index('>',i)+1
    if s[i+2:end-1].strip()!=tag:raise ValueError('Mismatched JSX closing tag at '+str(i))
    self.replacements.append((start,end,'(['+','.join(parts)+'])'));return end
   if s[i]=='<':
    a=i;i=self.element(i);parts.append(self.lower(a,i));continue
   if s[i]=='{':i=expr(i);continue
   i+=1
  raise ValueError('Unclosed JSX tag '+tag)
failed=0;count=0
for p in sorted(pathlib.Path('src').rglob('*')):
 if p.suffix not in ['.jsx','.js']:continue
 try:
  s=p.read_text()
  if p.suffix=='.jsx':scanner=Lower(s);scanner.code();s=scanner.lower(0,len(s))
  result=subprocess.run(['node','--check','--input-type=module'],input=s,text=True,capture_output=True)
  count+=1
  if result.returncode:failed+=1;print(str(p)+'\n'+result.stderr)
 except Exception as e:failed+=1;print(str(p)+': '+str(e))
print(f'Syntax checks: {count} files, {failed} failures (lexical JSX lowering, not a build).')
sys.exit(bool(failed))
