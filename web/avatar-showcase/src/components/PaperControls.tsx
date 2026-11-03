import { paperBacking, paperEnabled, paperGrain, setPaperBacking, setPaperEnabled, setPaperGrain } from '@/ui/paper'

export default function PaperControls() {
  return (
    <div class="summon-paper-tools" aria-label="纸片材质">
      <strong>Summon Bot · 纸片头像</strong>
      <label><input type="checkbox" checked={paperEnabled()} onChange={(event) => setPaperEnabled(event.currentTarget.checked)} />纸片材质</label>
      <label><input type="checkbox" checked={paperBacking()} disabled={!paperEnabled()} onChange={(event) => setPaperBacking(event.currentTarget.checked)} />衬纸</label>
      <label class="summon-grain-control">纸纹<input aria-label="纸纹强度" type="range" min="0" max="35" value={Math.round(paperGrain() * 100)} disabled={!paperEnabled()} onInput={(event) => setPaperGrain(Number(event.currentTarget.value) / 100)} /></label>
      <a href="#planche">全部状态</a>
    </div>
  )
}
