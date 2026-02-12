import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RealtimeService } from './realtime.service';
import { AfterViewInit, ElementRef, ViewChild } from '@angular/core';
import { Subscription } from 'rxjs';

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
  selectedDeviceId?: string;
  connected = false;

  systemPrompt =
    "Reply in a natural, human-like tone. Add brief pauses using '…' occasionally (not every sentence). " +
    "Avoid sounding robotic. Keep answers concise unless I ask for more detail.";

  constructor(private rt: RealtimeService) {}

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
    // SSR guard: navigator doesn't exist on the server
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
      return;
    }

    // request permission so device labels show
    try { await navigator.mediaDevices.getUserMedia({ audio: true }); } catch {}

    const all = await navigator.mediaDevices.enumerateDevices();
    this.devices = all.filter(d => d.kind === 'audioinput');
    if (!this.selectedDeviceId && this.devices[0]) this.selectedDeviceId = this.devices[0].deviceId;
  }

  async start() {
    await this.rt.connect(this.selectedDeviceId);
    this.connected = true;
  }

  stop() {
    this.rt.disconnect();
    this.connected = false;
  }
}
