import re,json,html,pathlib
class Scanner:
 def __init__(self,s): self.s=s;self.nodes=[];self.jsx=[];self.comments=[]
 def string(self,i,kind='string',attr=None):
  s=self.s;start=i;q=s[i];i+=1;parts=[];expr=[];p=i
  while i<len(s):
   if s[i]=='\\': i+=2;continue
   if s[i]==q:
    parts.append(s[p:i]);i+=1;break
   if q=='`' and s.startswith('${',i):
    parts.append(s[p:i]);a=i+2;i=self.code(a,'}');expr.append(s[a:i-1]);p=i;continue
   i+=1
  val=''
  for n,part in enumerate(parts):
   part=re.sub(r'\\([\\\'"`])',r'\1',part).replace('\\n','\n').replace('\\t','\t')
   val+=part
   if n<len(expr): val+='{p'+str(n+1)+'}'
  self.nodes.append(dict(start=start,end=i,text=val,kind=kind,attr=attr,expr=expr))
  return i
 def code(self,i=0,close=None):
  s=self.s
  while i<len(s):
   c=s[i]
   if c==close:return i+1
   if s.startswith('//',i):
    e=s.find('\n',i);e=len(s) if e<0 else e;self.comments.append((i,e));i=e;continue
   if s.startswith('/*',i):
    e=s.find('*/',i)+2;self.comments.append((i,e));i=e;continue
   if c in '\'"`': i=self.string(i);continue
   if c=='/' and not s.startswith('/>',i):
    # Regex literals follow an assignment, return, or expression delimiter.
    prev=s[:i].rstrip()
    if not prev or prev[-1] in '(=[:,!&|?' or prev.endswith('return'):
     j=i+1;cl=False
     while j<len(s) and s[j]!='\n':
      if s[j]=='\\': j+=2;continue
      if s[j]=='[':cl=True
      elif s[j]==']':cl=False
      elif s[j]=='/' and not cl:break
      j+=1
     if j<len(s) and s[j]=='/': i=j+1;continue
   if c=='<' and re.match(r'<(?:[A-Za-z][\w.:-]*(?:[\s/>])|>)',s[i:]):
    i=self.element(i);continue
   if c in '({[':i=self.code(i+1,{'(':')','{':'}','[':']'}[c]);continue
   i+=1
  if close:raise ValueError(('unclosed',close,s[max(0,i-80):i]))
  return i
 def element(self,i):
  s=self.s;start=i;i+=1
  m=re.match(r'[\w.:-]+',s[i:]);tag=m[0] if m else '';i+=len(tag)
  while i<len(s):
   if s.startswith('/>',i):return i+2
   if s[i]=='>':i+=1;break
   if s[i]=='{':i=self.code(i+1,'}');continue
   if s[i] in '\'"':
    m=re.search(r'([\w-]+)\s*=\s*$',s[start:i]);attr=m[1] if m else None
    i=self.string(i,'attribute',attr);continue
   i+=1
  while i<len(s):
   if s.startswith('</',i):return s.index('>',i)+1
   if s[i]=='<': i=self.element(i);continue
   if s[i]=='{':i=self.code(i+1,'}');continue
   a=i
   while i<len(s) and s[i] not in '<{':i+=1
   raw=s[a:i]
   # Match React's JSX whitespace normalization.
   lines=raw.replace('\r','').split('\n');parts=[]
   for n,l in enumerate(lines):
    l=l.replace('\t',' ')
    if n>0:l=l.lstrip(' ')
    if n<len(lines)-1:l=l.rstrip(' ')
    if l:parts.append(l)
   text=html.unescape(' '.join(parts))
   if text.strip():self.nodes.append(dict(start=a,end=i,text=text,kind='jsx',expr=[]))
  raise ValueError(('unclosed jsx',tag,start))

def candidates(p,s):
 sc=Scanner(s);sc.code()
 return sc
