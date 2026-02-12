import { ChangeDetectorRef, Component, OnInit } from '@angular/core';
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
  devicesLoading = false;
  devicesReady = false;

  systemPrompt =
    "Reply in a natural, human-like tone. Add brief pauses using '…' occasionally (not every sentence). " +
    "Avoid sounding robotic. Keep answers concise unless I ask for more detail.";

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

  async start() {
    await this.rt.connect(this.selectedDeviceId);
    this.connected = true;
  }

  stop() {
    this.rt.disconnect();
    this.connected = false;
  }

}
