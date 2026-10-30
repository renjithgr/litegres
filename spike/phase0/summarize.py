import glob,re,sys,xml.etree.ElementTree as ET
for d in sorted(glob.glob('build/results-*-f*')):
    t=f=e=0; fails=[]
    for x in glob.glob(d+'/*.xml'):
        r=ET.parse(x).getroot()
        for tc in r.iter('testcase'):
            t+=1
            bad=tc.find('failure') if tc.find('failure') is not None else tc.find('error')
            if bad is not None:
                fails.append((tc.get('classname').split('.')[-1],tc.get('name'),(bad.get('message') or '')[:140].replace('\n',' ')))
    print(d,'tests',t,'failed',len(fails))
    for x in fails: print('   FAIL',*x)
