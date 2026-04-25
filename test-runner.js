// test-runner.js - Game Boy Emulator Test Runner
const fs = require('fs');
const path = require('path');

const CYCLES_PER_FRAME = 70224;
const MAX_FRAMES = 2000; // max frames per test

class GameBoy {
  constructor() {
    this.rom = new Uint8Array(0x8000);
    this.vram = new Uint8Array(0x2000);
    this.wram = new Uint8Array(0x2000);
    this.oam = new Uint8Array(0xA0);
    this.io = new Uint8Array(0x80);
    this.hram = new Uint8Array(0x7F);
    this.ram = new Uint8Array(0x8000);

    this.a = this.f = this.b = this.c = this.d = this.e = this.h = this.l = 0;
    this.sp = 0xFFFE; this.pc = 0x0100;
    this.romBank = 1; this.ramBank = 0; this.mbcType = 0;
    this.ramEnable = false;

    this.scanline = 0; this.lineCycles = 0;
    this._divCounter = 0xAB00; this.TIMA = 0; this.TMA = 0; this.TAC = 0xF8;
    this._prevTimerBit = false;
    this.systemCycles = 0;
    this.interruptFlags = 0x00; this.ie = 0;
    this.ime = true; this.imePending = false;
    this.halted = false; this.stopped = false;
    this.joypadState = 0xFF; this.joypadSelect = 0;
    this.io[0x40] = 0x91; this.io[0x47] = 0xE4;
    this.io[0x48] = 0xE4; this.io[0x49] = 0xE4;
    this.io[0x41] = 0x80;

    // Serial output capture
    this.serialOutput = [];
    this.serialTransferCycles = 0;
    this.serialTransferring = false;

    // Debug: PC tracing for hang detection
    this._pcTrace = [];
    this._traceEnabled = false;
  }

  // === MMU ===
  read(addr) {
    addr &= 0xFFFF;
    if (addr < 0x4000) return this.rom[addr];
    if (addr < 0x8000) return this.rom[(addr & 0x3FFF) + this.romBank * 0x4000];
    if (addr < 0xA000) return this.vram[addr & 0x1FFF];
    if (addr < 0xC000) {
      if (this.ramEnable) return this.ram[(addr - 0xA000) + this.ramBank * 0x2000];
      return 0xFF;
    }
    if (addr < 0xE000) return this.wram[addr & 0x1FFF];
    if (addr < 0xFE00) return this.wram[addr & 0x1FFF];
    if (addr < 0xFEA0) return this.oam[addr & 0xFF];
    if (addr < 0xFF00) return 0xFF;
    if (addr < 0xFF80) return this.ioRead(addr & 0xFF);
    if (addr < 0xFFFF) return this.hram[addr & 0x7F];
    return this.ie;
  }

  write(addr, val) {
    addr &= 0xFFFF; val &= 0xFF;
    if (addr < 0x8000) { this.mbcWrite(addr, val); return; }
    if (addr < 0xA000) { this.vram[addr & 0x1FFF] = val; return; }
    if (addr < 0xC000) {
      if (this.ramEnable) this.ram[(addr - 0xA000) + this.ramBank * 0x2000] = val;
      return;
    }
    if (addr < 0xE000) { this.wram[addr & 0x1FFF] = val; return; }
    if (addr < 0xFE00) { this.wram[addr & 0x1FFF] = val; return; }
    if (addr < 0xFEA0) { this.oam[addr & 0xFF] = val; return; }
    if (addr < 0xFF00) return;
    if (addr < 0xFF80) { this.ioWrite(addr & 0xFF, val); return; }
    if (addr < 0xFFFF) { this.hram[addr & 0x7F] = val; return; }
    this.ie = val;
  }

  mbcWrite(addr, val) {
    if (this.mbcType === 0) return;
    if (addr < 0x2000) { this.ramEnable = (val & 0x0F) === 0x0A; return; }
    if (addr < 0x4000) { let b = val & 0x1F; if (b === 0) b = 1; this.romBank = b; return; }
    if (addr < 0x6000) { this.ramBank = val & 0x03; return; }
  }

  ioRead(port) {
    switch (port) {
      case 0x00: {
        let r = this.joypadSelect | 0x0F;
        if (!(this.joypadSelect & 0x10)) {
          if (!(this.joypadState & 0x01)) r &= ~0x08;
          if (!(this.joypadState & 0x02)) r &= ~0x04;
          if (!(this.joypadState & 0x04)) r &= ~0x02;
          if (!(this.joypadState & 0x08)) r &= ~0x01;
        }
        if (!(this.joypadSelect & 0x20)) {
          if (!(this.joypadState & 0x10)) r &= ~0x08;
          if (!(this.joypadState & 0x20)) r &= ~0x04;
          if (!(this.joypadState & 0x40)) r &= ~0x02;
          if (!(this.joypadState & 0x80)) r &= ~0x01;
        }
        return r;
      }
      case 0x01: return this.io[1];
      case 0x02: return this.io[2] | 0x7E; // SC: bits 1-6 read as 1
      case 0x04: return this._divCounter >> 8;
      case 0x05: return this.TIMA;
      case 0x06: return this.TMA;
      case 0x07: return this.TAC;
      case 0x0F: return this.interruptFlags | 0xE0;
      case 0x40: return this.io[0x40];
      case 0x41: return this.io[0x41];
      case 0x42: return this.io[0x42];
      case 0x43: return this.io[0x43];
      case 0x44: return this.scanline;
      case 0x45: return this.io[0x45];
      case 0x46: return this.io[0x46];
      case 0x47: return this.io[0x47];
      case 0x48: return this.io[0x48];
      case 0x49: return this.io[0x49];
      case 0x4A: return this.io[0x4A];
      case 0x4B: return this.io[0x4B];
      default: return this.io[port] || 0xFF;
    }
  }

  ioWrite(port, val) {
    switch (port) {
      case 0x00: this.joypadSelect = val & 0x30; return;
      case 0x01: this.io[1] = val; return; // SB write
      case 0x02:
        // SC: Serial Transfer Control
        if ((val & 0x81) === 0x81) {
          // Start transfer (internal clock)
          this.serialOutput.push(this.io[1]); // capture output byte
          this.io[2] = 0x7E; // clear bit 7 (transfer complete), bit 0
          this.interruptFlags |= 0x08; // Serial interrupt
        } else {
          this.io[2] = val | 0x7E;
        }
        return;
      case 0x04: this._divCounter = 0; return;
      case 0x05: this.TIMA = val; return;
      case 0x06: this.TMA = val; return;
      case 0x07: this.TAC = val | 0xF8; return;
      case 0x0F: this.interruptFlags = val & 0x1F; return;
      case 0x40: this.io[0x40] = val; return;
      case 0x41: this.io[0x41] = (val & 0xF8) | (this.io[0x41] & 0x07); return;
      case 0x42: this.io[0x42] = val; return;
      case 0x43: this.io[0x43] = val; return;
      case 0x45: this.io[0x45] = val; return;
      case 0x46: this.dma(val); return;
      case 0x47: this.io[0x47] = val; return;
      case 0x48: this.io[0x48] = val & 0xFC; return;
      case 0x49: this.io[0x49] = val & 0xFC; return;
      case 0x4A: this.io[0x4A] = val; return;
      case 0x4B: this.io[0x4B] = val; return;
      default: this.io[port] = val; return;
    }
  }

  dma(val) {
    let src = (val & 0xDF) << 8;
    for (let i = 0; i < 0xA0; i++) this.oam[i] = this.read(src | i);
  }

  // === CPU Helpers ===
  get AF() { return (this.a << 8) | (this.f & 0xF0); }
  set AF(v) { this.a = v >> 8; this.f = v & 0xF0; }
  get BC() { return (this.b << 8) | this.c; }
  set BC(v) { this.b = v >> 8; this.c = v & 0xFF; }
  get DE() { return (this.d << 8) | this.e; }
  set DE(v) { this.d = v >> 8; this.e = v & 0xFF; }
  get HL() { return (this.h << 8) | this.l; }
  set HL(v) { this.h = v >> 8; this.l = v & 0xFF; }

  flagZ(v) { this.f = v ? (this.f | 0x80) : (this.f & 0x7F); }
  flagN(v) { this.f = v ? (this.f | 0x40) : (this.f & 0xBF); }
  flagH(v) { this.f = v ? (this.f | 0x20) : (this.f & 0xDF); }
  flagC(v) { this.f = v ? (this.f | 0x10) : (this.f & 0xEF); }
  getZ() { return (this.f >> 7) & 1; }
  getN() { return (this.f >> 6) & 1; }
  getH() { return (this.f >> 5) & 1; }
  getC() { return (this.f >> 4) & 1; }

  tick(cycles) {
    for (let c = 0; c < cycles; c++) {
      this.systemCycles++;
      // DIV: 16-bit counter increments at CPU rate, upper 8 bits = DIV register
      this._divCounter = (this._divCounter + 1) & 0xFFFF;
      // Timer: TIMA increments on falling edge of selected bit of internal counter
      let tacEnable = this.TAC & 0x04;
      if (tacEnable) {
        let tb;
        switch (this.TAC & 0x03) { case 0: tb = 9; break; case 1: tb = 3; break; case 2: tb = 5; break; case 3: tb = 7; break; }
        let bit = (this._divCounter >> tb) & 1;
        if (this._prevTimerBit && !bit) {
          if (this.TIMA === 0xFF) { this.TIMA = this.TMA; this.interruptFlags |= 0x04; }
          else this.TIMA++;
        }
        this._prevTimerBit = bit;
      } else { this._prevTimerBit = false; }
      // PPU
      this.stepPPU();
    }
  }

  stepPPU() {
    if (!(this.io[0x40] & 0x80)) { this.scanline = 0; this.lineCycles = 0; this.io[0x41] = this.io[0x41] & 0xF8; return; }
    this.lineCycles++;
    let stat = this.io[0x41];
    let prevMode = stat & 0x03;
    let newMode;
    if (this.scanline >= 144) {
      newMode = 1;
      if (prevMode !== 1 && this.scanline === 144) {
        this.interruptFlags |= 0x01;
        if (stat & 0x10) this.interruptFlags |= 0x02;
      }
    } else {
      if (this.lineCycles < 80) newMode = 2;
      else if (this.lineCycles < 252) newMode = 3;
      else newMode = 0;
    }
    if (newMode !== prevMode) {
      if (newMode === 0 && (stat & 0x08)) this.interruptFlags |= 0x02;
      if (newMode === 1 && (stat & 0x10)) this.interruptFlags |= 0x02;
      if (newMode === 2 && (stat & 0x20)) this.interruptFlags |= 0x02;
    }
    if (this.scanline === this.io[0x45]) { stat |= 0x04; if (stat & 0x40) this.interruptFlags |= 0x02; }
    else stat &= 0xFB;
    this.io[0x41] = (stat & 0xF8) | newMode;
    if (this.lineCycles >= 456) { this.lineCycles = 0; this.scanline++; if (this.scanline >= 154) this.scanline = 0; }
  }

  handleInterrupts() {
    let pending = this.interruptFlags & this.ie & 0x1F;
    let anyFlag = this.interruptFlags & 0x1F;
    if (this.halted && anyFlag) { this.halted = false; }
    if (this.halted) return;
    if (!pending) return;
    if (!this.ime) return;
    this.ime = false;
    for (let i = 0; i < 5; i++) {
      if (pending & (1 << i)) {
        this.interruptFlags &= ~(1 << i);
        this.sp = (this.sp - 1) & 0xFFFF; this.write(this.sp, this.pc >> 8);
        this.sp = (this.sp - 1) & 0xFFFF; this.write(this.sp, this.pc & 0xFF);
        this.pc = 0x40 + i * 8; this.tick(20); return;
      }
    }
  }

  step() {
    if (this._traceEnabled) {
      this._pcTrace.push({ pc: this.pc, a: this.a, sp: this.sp, op: this.read(this.pc) });
      if (this._pcTrace.length > 500) this._pcTrace.shift();
    }
    if (this.stopped) { this.tick(4); return; }
    this.handleInterrupts();
    if (this.halted) { this.tick(4); return; }
    let op = this.read(this.pc);
    this.pc = (this.pc + 1) & 0xFFFF;
    this.exec(op);
    if (this.imePending) { this.ime = true; this.imePending = false; }
  }

  // === Helpers ===
  read8() { let v = this.read(this.pc); this.pc = (this.pc + 1) & 0xFFFF; return v; }
  read16() { return this.read8() | (this.read8() << 8); }
  readHL() { return this.read(this.HL); }
  writeHL(v) { this.write(this.HL, v); }

  push(v) { this.sp = (this.sp - 1) & 0xFFFF; this.write(this.sp, (v >> 8) & 0xFF); this.sp = (this.sp - 1) & 0xFFFF; this.write(this.sp, v & 0xFF); }
  pop() { let lo = this.read(this.sp); this.sp = (this.sp + 1) & 0xFFFF; let hi = this.read(this.sp); this.sp = (this.sp + 1) & 0xFFFF; return (hi << 8) | lo; }

  inc8(v) { let r = (v + 1) & 0xFF; this.flagZ(r === 0); this.flagN(0); this.flagH((v & 0x0F) === 0x0F); return r; }
  dec8(v) { let r = (v - 1) & 0xFF; this.flagZ(r === 0); this.flagN(1); this.flagH((v & 0x0F) === 0); return r; }

  add(v) { let r = this.a + v; this.flagZ((r & 0xFF) === 0); this.flagN(0); this.flagH((this.a & 0x0F) + (v & 0x0F) > 0x0F); this.flagC(r > 0xFF); this.a = r & 0xFF; }
  adc(v) { let c = this.getC(); let r = this.a + v + c; this.flagZ((r & 0xFF) === 0); this.flagN(0); this.flagH((this.a & 0x0F) + (v & 0x0F) + c > 0x0F); this.flagC(r > 0xFF); this.a = r & 0xFF; }
  sub(v) { let r = this.a - v; this.flagZ((r & 0xFF) === 0); this.flagN(1); this.flagH((this.a & 0x0F) < (v & 0x0F)); this.flagC(r < 0); this.a = r & 0xFF; }
  sbc(v) { let c = this.getC(); let r = this.a - v - c; this.flagZ((r & 0xFF) === 0); this.flagN(1); this.flagH((this.a & 0x0F) < (v & 0x0F) + c); this.flagC(r < 0); this.a = r & 0xFF; }
  and(v) { this.a &= v; this.flagZ(this.a === 0); this.flagN(0); this.flagH(1); this.flagC(0); }
  xor(v) { this.a ^= v; this.flagZ(this.a === 0); this.flagN(0); this.flagH(0); this.flagC(0); }
  or(v) { this.a |= v; this.flagZ(this.a === 0); this.flagN(0); this.flagH(0); this.flagC(0); }
  cp(v) { let r = this.a - v; this.flagZ((r & 0xFF) === 0); this.flagN(1); this.flagH((this.a & 0x0F) < (v & 0x0F)); this.flagC(r < 0); }

  addHL(v) { let r = this.HL + v; this.flagN(0); this.flagH((this.HL & 0xFFF) + (v & 0xFFF) > 0xFFF); this.flagC(r > 0xFFFF); this.HL = r & 0xFFFF; }
  addHLSp() { let v = this.sp; let r = this.HL + v; this.flagN(0); this.flagH((this.HL & 0xFFF) + (v & 0xFFF) > 0xFFF); this.flagC(r > 0xFFFF); this.HL = r & 0xFFFF; }

  addSP() { let r8 = (this.read8() << 24) >> 24; this.flagZ(0); this.flagN(0); this.flagH((this.sp & 0x0F) + (r8 & 0x0F) > 0x0F); this.flagC((this.sp & 0xFF) + (r8 & 0xFF) > 0xFF); this.sp = (this.sp + r8) & 0xFFFF; this.tick(16); }
  ldHLsp() { let r8 = (this.read8() << 24) >> 24; this.flagZ(0); this.flagN(0); this.flagH((this.sp & 0x0F) + (r8 & 0x0F) > 0x0F); this.flagC((this.sp & 0xFF) + (r8 & 0xFF) > 0xFF); this.HL = (this.sp + r8) & 0xFFFF; this.tick(12); }

  jr() { let r8 = (this.read8() << 24) >> 24; this.pc = (this.pc + r8) & 0xFFFF; this.tick(12); }
  jrCond(cond) { let r8 = (this.read8() << 24) >> 24; if (cond) { this.pc = (this.pc + r8) & 0xFFFF; this.tick(12); } else this.tick(8); }
  jpCond(cond) { let a16 = this.read16(); if (cond) { this.pc = a16; this.tick(16); } else this.tick(12); }
  call() { let a16 = this.read16(); this.push(this.pc); this.pc = a16; this.tick(24); }
  callCond(cond) { let a16 = this.read16(); if (cond) { this.push(this.pc); this.pc = a16; this.tick(24); } else this.tick(12); }
  retCond(cond) { this.tick(8); if (cond) { this.pc = this.pop(); this.tick(12); } }
  rst(vec) { this.push(this.pc); this.pc = vec; this.tick(16); }

  daa() {
    let a = this.a;
    if (!this.getN()) {
      if (this.getC() || a > 0x99) { a += 0x60; this.flagC(1); }
      if (this.getH() || (a & 0x0F) > 0x09) { a += 0x06; }
    } else {
      if (this.getC()) a -= 0x60;
      if (this.getH()) a -= 0x06;
    }
    this.a = a & 0xFF; this.flagZ(this.a === 0); this.flagH(0);
  }

  // === Full opcode execution ===
  exec(op) {
    let a16, v8;
    switch (op) {
      case 0x00: this.tick(4); break;
      case 0x01: this.BC = this.read16(); this.tick(12); break;
      case 0x02: this.write(this.BC, this.a); this.tick(8); break;
      case 0x03: this.BC = (this.BC + 1) & 0xFFFF; this.tick(8); break;
      case 0x04: this.b = this.inc8(this.b); this.tick(4); break;
      case 0x05: this.b = this.dec8(this.b); this.tick(4); break;
      case 0x06: this.b = this.read8(); this.tick(8); break;
      case 0x07: this.flagC(this.a >> 7); this.a = ((this.a << 1) | (this.a >> 7)) & 0xFF; this.flagZ(0); this.flagN(0); this.flagH(0); this.tick(4); break;
      case 0x08: a16 = this.read16(); this.write(a16, this.sp & 0xFF); this.write(a16 + 1, this.sp >> 8); this.tick(20); break;
      case 0x09: this.addHL(this.BC); this.tick(8); break;
      case 0x0A: this.a = this.read(this.BC); this.tick(8); break;
      case 0x0B: this.BC = (this.BC - 1) & 0xFFFF; this.tick(8); break;
      case 0x0C: this.c = this.inc8(this.c); this.tick(4); break;
      case 0x0D: this.c = this.dec8(this.c); this.tick(4); break;
      case 0x0E: this.c = this.read8(); this.tick(8); break;
      case 0x0F: this.flagC(this.a & 1); this.a = ((this.a >> 1) | (this.a << 7)) & 0xFF; this.flagZ(0); this.flagN(0); this.flagH(0); this.tick(4); break;
      case 0x10: this.read8(); this.stopped = true; this.tick(4); break;
      case 0x11: this.DE = this.read16(); this.tick(12); break;
      case 0x12: this.write(this.DE, this.a); this.tick(8); break;
      case 0x13: this.DE = (this.DE + 1) & 0xFFFF; this.tick(8); break;
      case 0x14: this.d = this.inc8(this.d); this.tick(4); break;
      case 0x15: this.d = this.dec8(this.d); this.tick(4); break;
      case 0x16: this.d = this.read8(); this.tick(8); break;
      case 0x17: { let c = this.getC(); this.flagC(this.a >> 7); this.a = ((this.a << 1) | c) & 0xFF; this.flagZ(0); this.flagN(0); this.flagH(0); this.tick(4); break; }
      case 0x18: this.jr(); break;
      case 0x19: this.addHL(this.DE); this.tick(8); break;
      case 0x1A: this.a = this.read(this.DE); this.tick(8); break;
      case 0x1B: this.DE = (this.DE - 1) & 0xFFFF; this.tick(8); break;
      case 0x1C: this.e = this.inc8(this.e); this.tick(4); break;
      case 0x1D: this.e = this.dec8(this.e); this.tick(4); break;
      case 0x1E: this.e = this.read8(); this.tick(8); break;
      case 0x1F: { let c = this.getC() << 7; this.flagC(this.a & 1); this.a = ((this.a >> 1) | c) & 0xFF; this.flagZ(0); this.flagN(0); this.flagH(0); this.tick(4); break; }
      case 0x20: this.jrCond(!this.getZ()); break;
      case 0x21: this.HL = this.read16(); this.tick(12); break;
      case 0x22: this.write(this.HL, this.a); this.HL = (this.HL + 1) & 0xFFFF; this.tick(8); break;
      case 0x23: this.HL = (this.HL + 1) & 0xFFFF; this.tick(8); break;
      case 0x24: this.h = this.inc8(this.h); this.tick(4); break;
      case 0x25: this.h = this.dec8(this.h); this.tick(4); break;
      case 0x26: this.h = this.read8(); this.tick(8); break;
      case 0x27: this.daa(); this.tick(4); break;
      case 0x28: this.jrCond(this.getZ()); break;
      case 0x29: this.addHL(this.HL); this.tick(8); break;
      case 0x2A: this.a = this.read(this.HL); this.HL = (this.HL + 1) & 0xFFFF; this.tick(8); break;
      case 0x2B: this.HL = (this.HL - 1) & 0xFFFF; this.tick(8); break;
      case 0x2C: this.l = this.inc8(this.l); this.tick(4); break;
      case 0x2D: this.l = this.dec8(this.l); this.tick(4); break;
      case 0x2E: this.l = this.read8(); this.tick(8); break;
      case 0x2F: this.a ^= 0xFF; this.flagN(1); this.flagH(1); this.tick(4); break;
      case 0x30: this.jrCond(!this.getC()); break;
      case 0x31: this.sp = this.read16(); this.tick(12); break;
      case 0x32: this.write(this.HL, this.a); this.HL = (this.HL - 1) & 0xFFFF; this.tick(8); break;
      case 0x33: this.sp = (this.sp + 1) & 0xFFFF; this.tick(8); break;
      case 0x34: this.writeHL(this.inc8(this.readHL())); this.tick(12); break;
      case 0x35: this.writeHL(this.dec8(this.readHL())); this.tick(12); break;
      case 0x36: this.writeHL(this.read8()); this.tick(12); break;
      case 0x37: this.flagN(0); this.flagH(0); this.flagC(1); this.tick(4); break;
      case 0x38: this.jrCond(this.getC()); break;
      case 0x39: this.addHLSp(); this.tick(8); break;
      case 0x3A: this.a = this.read(this.HL); this.HL = (this.HL - 1) & 0xFFFF; this.tick(8); break;
      case 0x3B: this.sp = (this.sp - 1) & 0xFFFF; this.tick(8); break;
      case 0x3C: this.a = this.inc8(this.a); this.tick(4); break;
      case 0x3D: this.a = this.dec8(this.a); this.tick(4); break;
      case 0x3E: this.a = this.read8(); this.tick(8); break;
      case 0x3F: this.flagN(0); this.flagH(0); this.flagC(!this.getC()); this.tick(4); break;
      // LD r,r' (0x40-0x7F)
      case 0x40: this.tick(4); break;
      case 0x41: this.b = this.c; this.tick(4); break;
      case 0x42: this.b = this.d; this.tick(4); break;
      case 0x43: this.b = this.e; this.tick(4); break;
      case 0x44: this.b = this.h; this.tick(4); break;
      case 0x45: this.b = this.l; this.tick(4); break;
      case 0x46: this.b = this.readHL(); this.tick(8); break;
      case 0x47: this.b = this.a; this.tick(4); break;
      case 0x48: this.c = this.b; this.tick(4); break;
      case 0x49: this.tick(4); break;
      case 0x4A: this.c = this.d; this.tick(4); break;
      case 0x4B: this.c = this.e; this.tick(4); break;
      case 0x4C: this.c = this.h; this.tick(4); break;
      case 0x4D: this.c = this.l; this.tick(4); break;
      case 0x4E: this.c = this.readHL(); this.tick(8); break;
      case 0x4F: this.c = this.a; this.tick(4); break;
      case 0x50: this.d = this.b; this.tick(4); break;
      case 0x51: this.d = this.c; this.tick(4); break;
      case 0x52: this.tick(4); break;
      case 0x53: this.d = this.e; this.tick(4); break;
      case 0x54: this.d = this.h; this.tick(4); break;
      case 0x55: this.d = this.l; this.tick(4); break;
      case 0x56: this.d = this.readHL(); this.tick(8); break;
      case 0x57: this.d = this.a; this.tick(4); break;
      case 0x58: this.e = this.b; this.tick(4); break;
      case 0x59: this.e = this.c; this.tick(4); break;
      case 0x5A: this.e = this.d; this.tick(4); break;
      case 0x5B: this.tick(4); break;
      case 0x5C: this.e = this.h; this.tick(4); break;
      case 0x5D: this.e = this.l; this.tick(4); break;
      case 0x5E: this.e = this.readHL(); this.tick(8); break;
      case 0x5F: this.e = this.a; this.tick(4); break;
      case 0x60: this.h = this.b; this.tick(4); break;
      case 0x61: this.h = this.c; this.tick(4); break;
      case 0x62: this.h = this.d; this.tick(4); break;
      case 0x63: this.h = this.e; this.tick(4); break;
      case 0x64: this.tick(4); break;
      case 0x65: this.h = this.l; this.tick(4); break;
      case 0x66: this.h = this.readHL(); this.tick(8); break;
      case 0x67: this.h = this.a; this.tick(4); break;
      case 0x68: this.l = this.b; this.tick(4); break;
      case 0x69: this.l = this.c; this.tick(4); break;
      case 0x6A: this.l = this.d; this.tick(4); break;
      case 0x6B: this.l = this.e; this.tick(4); break;
      case 0x6C: this.l = this.h; this.tick(4); break;
      case 0x6D: this.tick(4); break;
      case 0x6E: this.l = this.readHL(); this.tick(8); break;
      case 0x6F: this.l = this.a; this.tick(4); break;
      case 0x70: this.writeHL(this.b); this.tick(8); break;
      case 0x71: this.writeHL(this.c); this.tick(8); break;
      case 0x72: this.writeHL(this.d); this.tick(8); break;
      case 0x73: this.writeHL(this.e); this.tick(8); break;
      case 0x74: this.writeHL(this.h); this.tick(8); break;
      case 0x75: this.writeHL(this.l); this.tick(8); break;
      case 0x76: this.halted = true; this.tick(4); break;
      case 0x77: this.writeHL(this.a); this.tick(8); break;
      case 0x78: this.a = this.b; this.tick(4); break;
      case 0x79: this.a = this.c; this.tick(4); break;
      case 0x7A: this.a = this.d; this.tick(4); break;
      case 0x7B: this.a = this.e; this.tick(4); break;
      case 0x7C: this.a = this.h; this.tick(4); break;
      case 0x7D: this.a = this.l; this.tick(4); break;
      case 0x7E: this.a = this.readHL(); this.tick(8); break;
      case 0x7F: this.tick(4); break;
      // ALU A,r (0x80-0xBF)
      case 0x80: this.add(this.b); this.tick(4); break;
      case 0x81: this.add(this.c); this.tick(4); break;
      case 0x82: this.add(this.d); this.tick(4); break;
      case 0x83: this.add(this.e); this.tick(4); break;
      case 0x84: this.add(this.h); this.tick(4); break;
      case 0x85: this.add(this.l); this.tick(4); break;
      case 0x86: this.add(this.readHL()); this.tick(8); break;
      case 0x87: this.add(this.a); this.tick(4); break;
      case 0x88: this.adc(this.b); this.tick(4); break;
      case 0x89: this.adc(this.c); this.tick(4); break;
      case 0x8A: this.adc(this.d); this.tick(4); break;
      case 0x8B: this.adc(this.e); this.tick(4); break;
      case 0x8C: this.adc(this.h); this.tick(4); break;
      case 0x8D: this.adc(this.l); this.tick(4); break;
      case 0x8E: this.adc(this.readHL()); this.tick(8); break;
      case 0x8F: this.adc(this.a); this.tick(4); break;
      case 0x90: this.sub(this.b); this.tick(4); break;
      case 0x91: this.sub(this.c); this.tick(4); break;
      case 0x92: this.sub(this.d); this.tick(4); break;
      case 0x93: this.sub(this.e); this.tick(4); break;
      case 0x94: this.sub(this.h); this.tick(4); break;
      case 0x95: this.sub(this.l); this.tick(4); break;
      case 0x96: this.sub(this.readHL()); this.tick(8); break;
      case 0x97: this.sub(this.a); this.tick(4); break;
      case 0x98: this.sbc(this.b); this.tick(4); break;
      case 0x99: this.sbc(this.c); this.tick(4); break;
      case 0x9A: this.sbc(this.d); this.tick(4); break;
      case 0x9B: this.sbc(this.e); this.tick(4); break;
      case 0x9C: this.sbc(this.h); this.tick(4); break;
      case 0x9D: this.sbc(this.l); this.tick(4); break;
      case 0x9E: this.sbc(this.readHL()); this.tick(8); break;
      case 0x9F: this.sbc(this.a); this.tick(4); break;
      case 0xA0: this.and(this.b); this.tick(4); break;
      case 0xA1: this.and(this.c); this.tick(4); break;
      case 0xA2: this.and(this.d); this.tick(4); break;
      case 0xA3: this.and(this.e); this.tick(4); break;
      case 0xA4: this.and(this.h); this.tick(4); break;
      case 0xA5: this.and(this.l); this.tick(4); break;
      case 0xA6: this.and(this.readHL()); this.tick(8); break;
      case 0xA7: this.and(this.a); this.tick(4); break;
      case 0xA8: this.xor(this.b); this.tick(4); break;
      case 0xA9: this.xor(this.c); this.tick(4); break;
      case 0xAA: this.xor(this.d); this.tick(4); break;
      case 0xAB: this.xor(this.e); this.tick(4); break;
      case 0xAC: this.xor(this.h); this.tick(4); break;
      case 0xAD: this.xor(this.l); this.tick(4); break;
      case 0xAE: this.xor(this.readHL()); this.tick(8); break;
      case 0xAF: this.xor(this.a); this.tick(4); break;
      case 0xB0: this.or(this.b); this.tick(4); break;
      case 0xB1: this.or(this.c); this.tick(4); break;
      case 0xB2: this.or(this.d); this.tick(4); break;
      case 0xB3: this.or(this.e); this.tick(4); break;
      case 0xB4: this.or(this.h); this.tick(4); break;
      case 0xB5: this.or(this.l); this.tick(4); break;
      case 0xB6: this.or(this.readHL()); this.tick(8); break;
      case 0xB7: this.or(this.a); this.tick(4); break;
      case 0xB8: this.cp(this.b); this.tick(4); break;
      case 0xB9: this.cp(this.c); this.tick(4); break;
      case 0xBA: this.cp(this.d); this.tick(4); break;
      case 0xBB: this.cp(this.e); this.tick(4); break;
      case 0xBC: this.cp(this.h); this.tick(4); break;
      case 0xBD: this.cp(this.l); this.tick(4); break;
      case 0xBE: this.cp(this.readHL()); this.tick(8); break;
      case 0xBF: this.cp(this.a); this.tick(4); break;
      // Control flow 0xC0-0xFF
      case 0xC0: this.retCond(!this.getZ()); break;
      case 0xC1: this.BC = this.pop(); this.tick(12); break;
      case 0xC2: this.jpCond(!this.getZ()); break;
      case 0xC3: this.pc = this.read16(); this.tick(16); break;
      case 0xC4: this.callCond(!this.getZ()); break;
      case 0xC5: this.push(this.BC); this.tick(16); break;
      case 0xC6: this.add(this.read8()); this.tick(8); break;
      case 0xC7: this.rst(0x00); break;
      case 0xC8: this.retCond(this.getZ()); break;
      case 0xC9: this.pc = this.pop(); this.tick(16); break;
      case 0xCA: this.jpCond(this.getZ()); break;
      case 0xCB: this.execCB(); break;
      case 0xCC: this.callCond(this.getZ()); break;
      case 0xCD: this.call(); break;
      case 0xCE: this.adc(this.read8()); this.tick(8); break;
      case 0xCF: this.rst(0x08); break;
      case 0xD0: this.retCond(!this.getC()); break;
      case 0xD1: this.DE = this.pop(); this.tick(12); break;
      case 0xD2: this.jpCond(!this.getC()); break;
      case 0xD4: this.callCond(!this.getC()); break;
      case 0xD5: this.push(this.DE); this.tick(16); break;
      case 0xD6: this.sub(this.read8()); this.tick(8); break;
      case 0xD7: this.rst(0x10); break;
      case 0xD8: this.retCond(this.getC()); break;
      case 0xD9: this.pc = this.pop(); this.ime = true; this.tick(16); break;
      case 0xDA: this.jpCond(this.getC()); break;
      case 0xDC: this.callCond(this.getC()); break;
      case 0xDE: this.sbc(this.read8()); this.tick(8); break;
      case 0xDF: this.rst(0x18); break;
      case 0xE0: this.write(0xFF00 | this.read8(), this.a); this.tick(12); break;
      case 0xE1: this.HL = this.pop(); this.tick(12); break;
      case 0xE2: this.write(0xFF00 | this.c, this.a); this.tick(8); break;
      case 0xE5: this.push(this.HL); this.tick(16); break;
      case 0xE6: this.and(this.read8()); this.tick(8); break;
      case 0xE7: this.rst(0x20); break;
      case 0xE8: this.addSP(); break;
      case 0xE9: this.pc = this.HL; this.tick(4); break;
      case 0xEA: a16 = this.read16(); this.write(a16, this.a); this.tick(16); break;
      case 0xEE: this.xor(this.read8()); this.tick(8); break;
      case 0xEF: this.rst(0x28); break;
      case 0xF0: this.a = this.read(0xFF00 | this.read8()); this.tick(12); break;
      case 0xF1: this.AF = this.pop(); this.tick(12); break;
      case 0xF2: this.a = this.read(0xFF00 | this.c); this.tick(8); break;
      case 0xF3: this.ime = false; this.tick(4); break;
      case 0xF5: this.push(this.AF); this.tick(16); break;
      case 0xF6: this.or(this.read8()); this.tick(8); break;
      case 0xF7: this.rst(0x30); break;
      case 0xF8: this.ldHLsp(); break;
      case 0xF9: this.sp = this.HL; this.tick(8); break;
      case 0xFA: this.a = this.read(this.read16()); this.tick(16); break;
      case 0xFB: this.imePending = true; this.tick(4); break;
      case 0xFE: this.cp(this.read8()); this.tick(8); break;
      case 0xFF: this.rst(0x38); break;
      default: this.tick(4); break;
    }
  }

  execCB() {
    let cbOp = this.read(this.pc);
    this.pc = (this.pc + 1) & 0xFFFF;
    let regIdx = cbOp & 0x07;
    let bitNum = (cbOp >> 3) & 0x07;
    let opType = (cbOp >> 3) & 0x1F;
    let isHL = regIdx === 6;

    let getReg = () => {
      switch (regIdx) {
        case 0: return this.b; case 1: return this.c; case 2: return this.d; case 3: return this.e;
        case 4: return this.h; case 5: return this.l; case 6: return this.readHL(); case 7: return this.a;
      }
    };
    let setReg = (v) => {
      v &= 0xFF;
      switch (regIdx) {
        case 0: this.b = v; break; case 1: this.c = v; break; case 2: this.d = v; break; case 3: this.e = v; break;
        case 4: this.h = v; break; case 5: this.l = v; break; case 6: this.writeHL(v); break; case 7: this.a = v; break;
      }
    };

    if (opType < 8) {
      // RLC/RRC/RL/RR/SLA/SRA/SWAP/SRL
      let val = getReg();
      switch (opType) {
        case 0: this.flagC(val >> 7); val = ((val << 1) | (val >> 7)) & 0xFF; this.flagZ(val === 0); break;
        case 1: this.flagC(val & 1); val = ((val >> 1) | (val << 7)) & 0xFF; this.flagZ(val === 0); break;
        case 2: { let c = this.getC(); this.flagC(val >> 7); val = ((val << 1) | c) & 0xFF; this.flagZ(val === 0); break; }
        case 3: { let c = this.getC() << 7; this.flagC(val & 1); val = ((val >> 1) | c) & 0xFF; this.flagZ(val === 0); break; }
        case 4: this.flagC(val >> 7); val = (val << 1) & 0xFF; this.flagZ(val === 0); break;
        case 5: this.flagC(val & 1); val = (val & 0x80) | (val >> 1); this.flagZ(val === 0); break;
        case 6: val = ((val << 4) | (val >> 4)) & 0xFF; this.flagZ(val === 0); this.flagC(0); break;
        case 7: this.flagC(val & 1); val = (val >> 1) & 0xFF; this.flagZ(val === 0); break;
      }
      this.flagN(0); this.flagH(0);
      setReg(val);
      this.tick(isHL ? 16 : 8);
    } else if (opType < 16) {
      // BIT
      this.flagZ(!(getReg() & (1 << bitNum)));
      this.flagN(0); this.flagH(1);
      this.tick(isHL ? 12 : 8);
    } else if (opType < 24) {
      // RES
      setReg(getReg() & ~(1 << bitNum));
      this.tick(isHL ? 16 : 8);
    } else {
      // SET
      setReg(getReg() | (1 << bitNum));
      this.tick(isHL ? 16 : 8);
    }
  }

  loadROM(data) {
    this.rom.fill(0);
    for (let i = 0; i < data.length && i < 0x8000; i++) this.rom[i] = data[i];
    this.mbcType = this.rom[0x0147];
    this.serialOutput = [];
    this.reset();
  }

  reset() {
    this.a = 0x01; this.f = 0xB0; this.b = 0x00; this.c = 0x13;
    this.d = 0x00; this.e = 0xD8; this.h = 0x01; this.l = 0x4D;
    this.sp = 0xFFFE; this.pc = 0x0100;
    this.vram.fill(0); this.wram.fill(0); this.oam.fill(0);
    this.io.fill(0); this.hram.fill(0);
    this.romBank = 1; this.ramBank = 0; this.ramEnable = false; this.ram.fill(0);
    this.scanline = 0; this.lineCycles = 0;
    this._divCounter = 0xAB00; this.TIMA = 0; this.TMA = 0; this.TAC = 0xF8;
    this._prevTimerBit = false;
    this.systemCycles = 0; this.interruptFlags = 0x00; this.ie = 0;
    this.ime = true; this.imePending = false; this.halted = false; this.stopped = false;
    this.joypadState = 0xFF; this.joypadSelect = 0;
    this.io[0x40] = 0x91; this.io[0x47] = 0xE4;
    this.io[0x48] = 0xE4; this.io[0x49] = 0xE4;
    this.io[0x41] = 0x80;
    this.io[2] = 0x7E; // SC default
    this.serialOutput = [];
    this.serialTransferring = false;
  }

  runFrame() {
    this.systemCycles = 0;
    while (this.systemCycles < CYCLES_PER_FRAME) {
      this.step();
      // Safety: detect infinite loop (same PC with same state)
      if (this.systemCycles > CYCLES_PER_FRAME * 10) break;
    }
  }
}

// === Run all tests ===
const testDir = '/Users/junchengliao/Desktop/Test deepseekv4/individual';
const testFiles = fs.readdirSync(testDir).filter(f => f.endsWith('.gb')).sort();

console.log('=== Game Boy Emulator - Individual Instruction Tests ===\n');

let passed = 0;
let failed = 0;
let results = [];

for (const fn of testFiles) {
  const filePath = path.join(testDir, fn);
  const romData = new Uint8Array(fs.readFileSync(filePath));
  const gb = new GameBoy();
  gb.loadROM(romData);

  // Run for max frames
  let serialStr = '';
  let done = false;
  let lastSerialLen = 0;
  let unchangedFrames = 0;
  for (let frame = 0; frame < MAX_FRAMES && !done; frame++) {
    gb.runFrame();

    // Check for serial output each frame
    if (gb.serialOutput.length > 0) {
      serialStr = String.fromCharCode(...gb.serialOutput);

      // Check for test completion indicators
      if (serialStr.includes('Passed') || serialStr.includes('Failed') ||
          serialStr.includes('pass') || serialStr.includes('fail') ||
          serialStr.includes('All tests passed') || serialStr.includes('ok')) {
        if (frame > 5) done = true;
      }

      // Track if serial output is growing
      if (gb.serialOutput.length === lastSerialLen) {
        unchangedFrames++;
      } else {
        unchangedFrames = 0;
        lastSerialLen = gb.serialOutput.length;
      }
    }

    // Early termination for completely hung tests
    if (frame > 1200 && serialStr.length === 0) {
      done = true;
    }

    // If we have some output but it hasn't changed in 500 frames, enable tracing
    if (serialStr.length > 0 && unchangedFrames > 500 && !gb._traceEnabled) {
      gb._traceEnabled = true;
    }
  }

  // Run a few more frames to get final output
  for (let f = 0; f < 10; f++) gb.runFrame();
  serialStr = String.fromCharCode(...gb.serialOutput);

  // Determine pass/fail
  let status = '???';
  if (serialStr.includes('Passed') || serialStr.includes('All tests passed')) {
    status = 'PASS';
    passed++;
  } else if (serialStr.includes('Failed') || serialStr.includes('fail')) {
    status = 'FAIL';
    failed++;
  } else if (serialStr.length > 0) {
    status = 'PARTIAL';
  } else {
    status = 'NO OUTPUT';
  }

  results.push({ name: fn, status, output: serialStr.replace(/\x00/g, ' ').trim() });

  // Print result
  const statusColor = status === 'PASS' ? '✓' : status === 'FAIL' ? '✗' : '?';
  console.log(`${statusColor} ${fn}: ${status}`);
  if (status !== 'PASS' && serialStr.length > 0) {
    let preview = serialStr.replace(/[\x00-\x1f]/g, (c) => c === '\n' ? '\\n' : '?').substring(0, 200);
    console.log(`   Output: ${preview}`);
  }
  if (status === 'NO OUTPUT') {
    console.log(`   (No serial output after ${MAX_FRAMES} frames)`);
  }
  if (status === 'PARTIAL' && gb._pcTrace.length > 0) {
    // Show raw serial bytes for debugging
    let rawBytes = Array.from(gb.serialOutput).map(b => b.toString(16).padStart(2,'0')).join(' ');
    console.log(`   Raw bytes: ${rawBytes}`);
    // Show last 30 unique PCs
    let seen = new Set();
    let unique = [];
    for (let i = gb._pcTrace.length - 1; i >= 0 && unique.length < 30; i--) {
      let key = gb._pcTrace[i].pc;
      if (!seen.has(key)) { seen.add(key); unique.push(gb._pcTrace[i]); }
    }
    unique.reverse();
    let traceStr = unique.map(t => `  PC=${t.pc.toString(16).padStart(4,'0')} op=${t.op.toString(16).padStart(2,'0')} A=${t.a.toString(16).padStart(2,'0')} SP=${t.sp.toString(16).padStart(4,'0')}`).join('\n');
    console.log(`   Last PCs:\n${traceStr}`);
  }
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed, ${results.length - passed - failed} other ===`);
