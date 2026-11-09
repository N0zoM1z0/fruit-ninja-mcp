#!/usr/bin/env python3
"""Measure visible game updates, inside the game arena, excluding the HUD."""
import argparse
import json
from pathlib import Path
import subprocess
import numpy as np

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('session',type=Path)
    args=parser.parse_args()
    directory=args.session
    meta=json.loads((directory/'metadata.json').read_text())
    start=meta['gameplay_start_video_s']
    end=start+meta['native_round_wall_seconds']
    # The video's origin uses the recorder start, before common menu navigation.
    from datetime import datetime
    origin=datetime.fromisoformat(meta['round_started_at'].replace('Z','+00:00')).timestamp()-start
    samples=[]
    executions=[]
    for line in (directory/'viewer-events.jsonl').read_text().splitlines():
        event=json.loads(line)
        if event['type']=='state':
            scene=event.get('scene')
            active=any(e.get('moving') and np.hypot(e['vx'],e['vy'])>20 for e in scene.get('fruits',[])+scene.get('bombs',[])) if scene else None
            samples.append(((event['at']/1000-origin),active))
        elif event['type']=='execution':executions.append(event['execution'])
    probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-select_streams','v:0','-show_entries','stream=avg_frame_rate,width,height,nb_frames:format=duration','-of','json',str(directory/'video.mp4')]))
    n,d=map(int,probe['streams'][0]['avg_frame_rate'].split('/'));fps=n/d
    process=subprocess.Popen(['ffmpeg','-v','error','-threads','2','-i',str(directory/'video.mp4'),'-vf','crop=1024:768:0:0,scale=384:288:flags=area,format=gray','-threads','2','-f','rawvideo','-'],stdout=subprocess.PIPE)
    previous=None;changes=[]
    while True:
        data=process.stdout.read(384*288)
        if not data:break
        if len(data)!=384*288:raise RuntimeError('Incomplete decoded frame')
        frame=np.frombuffer(data,np.uint8).reshape(288,384)[30:265,8:376].astype(np.int16)
        if previous is not None:changes.append(float((np.abs(frame-previous)>4).mean()))
        previous=frame
    if process.wait()!=0:raise RuntimeError('Decoder failed')
    changed=np.array(changes);times=np.arange(1,len(changed)+1)/fps
    playing=(times>start+.3)&(times<end-.3)
    if samples and any(active is not None for _,active in samples):
        indices=np.clip(np.searchsorted([t for t,_ in samples],times,side='right')-1,0,len(samples)-1)
        active=playing&np.array([bool(samples[i][1]) for i in indices])
        method='Native referee indicates moving fruit/bombs; game arena only, HUD excluded.'
    else:
        active=playing
        method='All gameplay frames; idle gaps included because GUI telemetry omits native entities.'
    rows=[]
    for threshold in [.0005,.001,.002,.004]:
        updated=changed>threshold;gaps=[];prev=None
        for i in np.where(active)[0]:
            if not i or not active[i-1]:prev=None
            if updated[i]:
                if prev is not None:gaps.append((i-prev)/fps*1000)
                prev=i
        rows.append({'changed_area_threshold':threshold,'visible_updates_per_second':float(fps*updated[active].mean()),'update_gap_ms_p50_p95_p99':np.percentile(gaps,[50,95,99]).tolist() if gaps else []})
    updated=changed>.001
    bins=[]
    for sec in range(int(start)+1,int(end)):
        mask=(times>=sec)&(times<sec+1)&active
        if mask.sum()>=fps/2:bins.append((sec,float(fps*updated[mask].mean())))
    report={'capture':probe,'measurement':method,'gameplay_start_s':start,'gameplay_end_s':end,'measured_seconds':float(active.sum()/fps),'threshold_sensitivity':rows,'one_second_fps_min_p10_median':np.percentile([value for _,value in bins],[0,10,50]).tolist() if bins else [],'input_max_sample_lateness_ms_p50_p95':np.percentile([x['max_sample_lateness_ms'] for x in executions],[50,95]).tolist() if executions else [],'limitations':['Visible pixel updates are bounded by 30fps capture; this does not measure engine or GPU presentation FPS.','Native motion flags are sampled at 5Hz; alignment is approximate. Different unseeded rounds have different scene loads.']}
    (directory/'quality.json').write_text(json.dumps(report,indent=2)+'\n')
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    plt.figure(figsize=(11,3));plt.plot([t-start for t,_ in bins],[x for _,x in bins],color='#258b99',lw=1.7)
    plt.ylim(0,32);plt.yticks([0,10,20,30]);plt.grid(alpha=.2);plt.xlabel('Seconds since player start');plt.ylabel('Visible updates / second');plt.title(f"Fruit Ninja · {meta['mode'].upper()} · 30 fps capture");plt.tight_layout();plt.savefig(directory/'frame-pacing.png',dpi=160);plt.close()
    print(json.dumps(report,indent=2))

if __name__=='__main__':main()
