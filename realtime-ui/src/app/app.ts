import { ChangeDetectorRef, Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RealtimeService } from './realtime.service';
import { AfterViewInit, ElementRef, ViewChild } from '@angular/core';
import { Subscription } from 'rxjs';
import {DEFAULT_SYSTEM_PROMPT} from './constant';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.html'
})

export class App implements OnInit, AfterViewInit {

  @ViewChild('chatBody') chatBody?: ElementRef<HTMLDivElement>;
  private sub?: Subscription;
  devices: MediaDeviceInfo[] = [];
  resumeText = '';
  systemPrompt = DEFAULT_SYSTEM_PROMPT;
  selectedDeviceId?: string;
  connected = false;
  devicesLoading = false;
  devicesReady = false;
  showDebug = false;
  debugEnabled = true;

  constructor(private rt: RealtimeService, private cdr: ChangeDetectorRef) {}

  get messages$() {
    return this.rt.messages$;
  }

  async ngOnInit() {
    await this.loadDevices();
  }

  ngAfterViewInit() {
    this.sub = this.messages$.subscribe(() => {
      queueMicrotask(() => {
        const el = this.chatBody?.nativeElement;
        if (el) el.scrollTop = el.scrollHeight;
      });
    });
  }

  ngOnDestroy() {
    this.sub?.unsubscribe();
  }

  async loadDevices() {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) return;

    this.devicesLoading = true;
    this.devicesReady = false;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Important: stop tracks so you don't keep the mic open
      stream.getTracks().forEach(t => t.stop());
    } catch {
      // permission denied or blocked; still try enumerate (may be limited)
    }

    const all = await navigator.mediaDevices.enumerateDevices();
    this.devices = all.filter(d => d.kind === 'audioinput');

    if (!this.selectedDeviceId && this.devices[0]) {
      this.selectedDeviceId = this.devices[0].deviceId;
    }

    this.devicesLoading = false;
    this.devicesReady = true;

    // Helps if anything runs outside Angular zone
    this.cdr.detectChanges();
  }

  buildPrompt(): string {
    const prompt = this.systemPrompt.trim() ||
      'You are a helpful assistant. Respond in a natural, human-like tone.';
    if (!this.resumeText.trim()) return prompt;
    return `${prompt}\n\nRESUME:\n${this.resumeText.trim()}`;
  }

  async start() {
    await this.rt.connect(this.selectedDeviceId, this.vad, this.buildPrompt());
    this.connected = true;
  }

  stop() {
    this.rt.disconnect();
    this.connected = false;
  }

  get debug$() {
    return this.rt.debug$;
  }

  toggleDebugEnabled() {
    this.debugEnabled = !this.debugEnabled;
    this.rt.setDebugEnabled(this.debugEnabled);
  }

  clearDebug() {
    this.rt.clearDebug();
  }

  async copyDebug(events: any[]) {
    const text = events
      .map((e: any) => `${new Date(e.ts).toLocaleTimeString()} | ${e.type}${e.summary ? ' | ' + e.summary : ''}`)
      .join('\n');

    await navigator.clipboard.writeText(text);
  }

  get state$() {
    return this.rt.state$;
  }

  stateLabel(s: string | null | undefined) {
    switch (s) {
      case 'connecting': return 'Connecting…';
      case 'listening': return 'Listening';
      case 'thinking': return 'Thinking…';
      case 'responding': return 'Responding…';
      case 'reconnecting': return 'Reconnecting…';
      case 'error': return 'Error';
      case 'disconnected': return 'Disconnected';
      default: return 'Idle';
    }
  }

  private getMessagesSnapshot() {
    // BehaviorSubject is private, so we pull from observable once using current value:
    // easiest is to add a helper in service, but we can also subscribe once.
    // Best: add a method in service. We'll do that.
  }

  exportJson() {
    const msgs = this.rt.getMessages().map(m => ({
      ts: m.ts,
      iso: new Date(m.ts).toISOString(),
      role: m.role,
      text: m.text.replace(/^\[draft\]/, '') // strip draft tag just in case
    }));

    const blob = new Blob([JSON.stringify(msgs, null, 2)], { type: 'application/json' });
    this.downloadBlob(blob, `conversation-${this.fileStamp()}.json`);
  }

  exportTxt() {
    const msgs = this.rt.getMessages().map(m => {
      const time = new Date(m.ts).toLocaleString();
      const who = m.role === 'user' ? 'You' : 'Assistant';
      const text = m.text.replace(/^\[draft\]/, '');
      return `[${time}] ${who}:\n${text}\n`;
    });

    const blob = new Blob([msgs.join('\n')], { type: 'text/plain' });
    this.downloadBlob(blob, `conversation-${this.fileStamp()}.txt`);
  }

  async copyTranscript() {
    const msgs = this.rt.getMessages().map(m => {
      const who = m.role === 'user' ? 'You' : 'Assistant';
      const text = m.text.replace(/^\[draft\]/, '');
      return `${who}: ${text}`;
    }).join('\n\n');

    await navigator.clipboard.writeText(msgs);
  }

  private fileStamp() {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }

  private downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  vad = {
    threshold: 0.5,
    prefixPaddingMs: 300,
    silenceDurationMs: 2000
  };

  resetVad() {
    this.vad = { threshold: 0.5, prefixPaddingMs: 300, silenceDurationMs: 1000 };
  }

}
