const fs = require('fs');

const COLORS = [
  [154, 213, 144], // lightest (0)
  [78, 133, 66],   // light (1)
  [24, 55, 16],    // dark (2)
  [0, 0, 0]        // darkest (3)
];

const CYCLES_PER_FRAME = 70224;

function inc16(v) { return (v + 1) & 0xFFFF; }
function dec16(v) { return (v - 1) & 0xFFFF; }

class GameBoy {
  constructor() {
    this.rom = new Uint8Array(0);
    this.a = 0; this.f = 0; this.b = 0; this.c = 0; this.d = 0; this.e = 0; this.h = 0; this.l = 0;
    this.sp = 0; this.pc = 0;
    this.vram = new Uint8Array(0x2000); this.wram = new Uint8Array(0x2000);
    this.oam = new Uint8Array(0xA0); this.io = new Uint8Array(0x80);
    this.hram = new Uint8Array(0x7F); this.ram = new Uint8Array(0x8000);
    this.romBank = 1; this.ramBank = 0; this.mbcType = 0; this.ramEnable = false;
    this.scanline = 0; this.lineCycles = 0;
    this._divCounter = 0; this.TIMA = 0; this.TMA = 0; this.TAC = 0;
    this.systemCycles = 0;
    this.interruptFlags = 0; this.ie = 0;
    this.ime = true; this.imePending = false;
    this.halted = false; this.stopped = false;
    this.joypadState = 0xFF; this.joypadSelect = 0;
    this._prevTimerBit = false;
    this._lycMatched = false;
    this.frameBuffer = new Uint8ClampedArray(160 * 144 * 4);
    this.bgColorIdx = new Uint8Array(160);
    this.statHandlerLog = [];
  }

  loadROM(data) {
    this.rom = new Uint8Array(data);
    this.mbcType = data[0x0147];
    this.reset();
  }

  reset() {
    this.a = 0x01; this.f = 0xB0;
    this.b = 0x00; this.c = 0x13;
    this.d = 0x00; this.e = 0xD8;
    this.h = 0x01; this.l = 0x4D;
    this.sp = 0xFFFE; this.pc = 0x0100;
    this.vram.fill(0); this.wram.fill(0); this.oam.fill(0);
    this.io.fill(0); this.hram.fill(0);
    this.romBank = 1; this.ramBank = 0; this.ramEnable = false; this.ram.fill(0);
    this.scanline = 0; this.lineCycles = 0;
    this._divCounter = 0xAB00; this.TIMA = 0; this.TMA = 0; this.TAC = 0xF8;
    this.systemCycles = 0;
    this.interruptFlags = 0x00;
    this.ie = 0;
    this.ime = true; this.imePending = false;
    this.halted = false; this.stopped = false;
    this.joypadState = 0xFF; this.joypadSelect = 0;
    this._prevTimerBit = false;
    this._lycMatched = false;
    this.io[0x40] = 0x91; this.io[0x47] = 0xE4;
    this.io[0x48] = 0xE4; this.io[0x49] = 0xE4;
    this.io[0x41] = 0x80;
    this.frameBuffer.fill(0);
  }

  mbcWrite(addr, val) {
    if (this.mbcType === 0) return;
    if (addr < 0x2000) {
      this.ramEnable = (val & 0x0F) === 0x0A;
    } else if (addr < 0x4000) {
      let bank = val & (this.mbcType <= 0x03 ? 0x1F : 0x7F);
      if (bank === 0) bank = 1;
      this.romBank = bank;
    } else if (addr < 0x6000) {
      if (this.mbcType >= 0x0F && this.mbcType <= 0x13) {
        this.ramBank = val & 0x0F;
      } else {
        this.ramBank = val & 0x03;
      }
    }
  }

  read(addr) {
    addr &= 0xFFFF;
    if (addr < 0x4000) return this.rom[addr];
    if (addr < 0x8000) {
      let offset = (addr & 0x3FFF) + this.romBank * 0x4000;
      if (offset >= this.rom.length) offset &= (this.rom.length - 1);
      return this.rom[offset];
    }
    if (addr < 0xA000) return this.vram[addr & 0x1FFF];
    if (addr < 0xC000) {
      if (!this.ramEnable) return 0xFF;
      if (this.ramBank >= 4) return 0xFF;
      return this.ram[(addr - 0xA000) + this.ramBank * 0x2000];
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
      if (this.ramEnable && this.ramBank < 4) this.ram[(addr - 0xA000) + this.ramBank * 0x2000] = val;
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
      case 0x02: return this.io[2];
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
      case 0x01: this.io[1] = val; return;
      case 0x02: this.io[2] = val; return;
      case 0x04: this._divCounter = 0; return;
      case 0x05: this.TIMA = val; return;
      case 0x06: this.TMA = val; return;
      case 0x07: this.TAC = val; return;
      case 0x0F: this.interruptFlags = val & 0x1F; return;
      case 0x40: this.io[0x40] = val; return;
      case 0x41: this.io[0x41] = val; return;
      case 0x42: this.io[0x42] = val; return;
      case 0x43: this.io[0x43] = val; return;
      case 0x44: return; // LY readonly
      case 0x45: this.io[0x45] = val; return;
      case 0x46: { // DMA
        let src = (val & 0xDF) << 8;
        for (let i = 0; i < 0xA0; i++) this.oam[i] = this.read(src | i);
        return;
      }
      case 0x47: this.io[0x47] = val; return;
      case 0x48: this.io[0x48] = val & 0xFC; return;
      case 0x49: this.io[0x49] = val & 0xFC; return;
      case 0x4A: this.io[0x4A] = val; return;
      case 0x4B: this.io[0x4B] = val; return;
      default: this.io[port] = val; return;
    }
  }

  tick(cycles) {
    this.systemCycles += cycles;

    // Timer
    for (let i = 0; i < cycles; i++) {
      this._divCounter = (this._divCounter + 1) & 0xFFFF;
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
    }

    // PPU - one T-cycle = one PPU cycle
    for (let i = 0; i < cycles; i++) this.stepPPU();
  }

  stepPPU() {
    if (!(this.io[0x40] & 0x80)) {
      this.scanline = 0;
      this.lineCycles = 0;
      this.io[0x41] = (this.io[0x41] & 0xF8) | 0x00;
      return;
    }

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
      if (this.lineCycles < 80) {
        newMode = 2;
      } else if (this.lineCycles < 252) {
        newMode = 3;
      } else {
        newMode = 0;
      }
    }

    if (newMode !== prevMode) {
      if (newMode === 0 && (stat & 0x08)) this.interruptFlags |= 0x02;
      if (newMode === 1 && (stat & 0x10)) this.interruptFlags |= 0x02;
      if (newMode === 2 && (stat & 0x20)) this.interruptFlags |= 0x02;
    }

    let lycMatch = this.scanline === this.io[0x45];
    if (lycMatch) {
      stat |= 0x04;
      if (!this._lycMatched && (stat & 0x40)) this.interruptFlags |= 0x02;
    } else {
      stat &= 0xFB;
    }
    this._lycMatched = lycMatch;

    this.io[0x41] = (stat & 0xF8) | newMode;

    if (this.lineCycles === 252 && this.scanline < 144) {
      if (!this._traceDone && this.scanline === 0) {
        if (!this._traceFrame) this._traceFrame = 0;
        this._traceFrame++;
        if (this._traceFrame === 6) {
          console.log('=== LCDC trace frame ' + this._traceFrame + ' ===');
        }
      }
      if (this._traceFrame === 6 && !this._traceDone && this.scanline < 144) {
        let lcdc = this.io[0x40];
        let keyLines = [0,7,8,9,15,16,29,30,37,38,47,48,55,56,63,64,69,70,79,80,81,82,87,88,89,90,103,104,111,112,127,128,129,130,142,143];
        if (keyLines.includes(this.scanline)) {
          console.log('  LY=' + this.scanline + ' LCDC=' + lcdc.toString(2).padStart(8,'0') + ' lyc=' + this.io[0x45] + ' scx=' + this.io[0x43] + ' scy=' + this.io[0x42] + ' wx=' + this.io[0x4B] + ' wy=' + this.io[0x4A]);
        }
        if (this.scanline === 143) this._traceDone = true;
      }
      this.renderScanline(this.scanline);
    }

    if (this.lineCycles >= 456) {
      this.lineCycles = 0;
      this.scanline++;
      if (this.scanline >= 154) this.scanline = 0;
    }
  }

  putPixel(x, y, colorIdx) {
    let c = COLORS[colorIdx & 3];
    let i = (y * 160 + x) * 4;
    this.frameBuffer[i] = c[0];
    this.frameBuffer[i + 1] = c[1];
    this.frameBuffer[i + 2] = c[2];
    this.frameBuffer[i + 3] = 255;
  }

  putPixelBG(x, y, colorIdx) {
    this.bgColorIdx[x] = colorIdx & 3;
    this.putPixel(x, y, colorIdx);
  }

  renderScanline(ly) {
    let lcdc = this.io[0x40];
    this.renderBG(ly, lcdc);
    if (lcdc & 0x02) this.renderSprites(ly, lcdc);
  }

  renderBG(ly, lcdc) {
    let bgp = this.io[0x47];
    let scx = this.io[0x43];
    let scy = this.io[0x42];

    if (!(lcdc & 0x01)) {
      for (let x = 0; x < 160; x++) this.putPixelBG(x, ly, 0);
      return;
    }

    let tileMap = (lcdc & 0x08) ? 0x1C00 : 0x1800;
    let tileData = (lcdc & 0x10) ? 0x0000 : 0x0800;
    let signed = tileData === 0x0800;

    let y = (ly + scy) & 0xFF;
    let tileRow = (y >> 3) & 31;
    let lineInTile = y & 7;

    for (let px = 0; px < 160; px++) {
      let x = (px + scx) & 0xFF;
      let tileCol = (x >> 3) & 31;
      let bitInTile = 7 - (x & 7);

      let tileIdx = this.vram[tileMap + tileRow * 32 + tileCol];
      let addr = signed
        ? 0x800 + ((tileIdx + 128) & 0xFF) * 16
        : tileIdx * 16;

      let lo = this.vram[addr + lineInTile * 2];
      let hi = this.vram[addr + lineInTile * 2 + 1];
      let color = ((hi >> bitInTile) & 1) << 1 | ((lo >> bitInTile) & 1);
      this.putPixelBG(px, ly, (bgp >> (color * 2)) & 3);
    }

    // Window
    if ((lcdc & 0x20) && this.io[0x4A] <= ly) {
      let wy = this.io[0x4A];
      let wx = this.io[0x4B] - 7;
      let winTileMap = (lcdc & 0x40) ? 0x1C00 : 0x1800;
      let winY = ly - wy;
      let winTileRow = (winY >> 3) & 31;
      let winLineInTile = winY & 7;

      for (let px = 0; px < 160; px++) {
        if (px < wx) continue;
        let winX = px - wx;
        let winTileCol = (winX >> 3) & 31;
        let bitInTile = 7 - (winX & 7);

        let tileIdx = this.vram[winTileMap + winTileRow * 32 + winTileCol];
        let addr = signed
          ? 0x800 + ((tileIdx + 128) & 0xFF) * 16
          : tileIdx * 16;

        let lo = this.vram[addr + winLineInTile * 2];
        let hi = this.vram[addr + winLineInTile * 2 + 1];
        let color = ((hi >> bitInTile) & 1) << 1 | ((lo >> bitInTile) & 1);
        this.putPixelBG(px, ly, (bgp >> (color * 2)) & 3);
      }
    }
  }

  renderSprites(ly, lcdc) {
    let height = (lcdc & 0x04) ? 16 : 8;
    let sprites = [];

    for (let i = 0; i < 40; i++) {
      let sy = this.oam[i * 4] - 16;
      let sx = this.oam[i * 4 + 1] - 8;
      if (ly >= sy && ly < sy + height) {
        sprites.push({
          x: sx, y: sy, tile: this.oam[i * 4 + 2],
          flags: this.oam[i * 4 + 3], idx: i
        });
      }
      if (sprites.length >= 10) break;
    }

    // Sort: larger X first (drawn first), then higher OAM index first
    // → smaller X + lower OAM index drawn LAST (on top / higher priority)
    sprites.sort((a, b) => {
      if (a.x !== b.x) return b.x - a.x;  // larger X drawn first
      return b.idx - a.idx;  // higher OAM index drawn first
    });

    for (let s of sprites) {
      let lineOffset = ly - s.y;
      if (s.flags & 0x40) lineOffset = height - 1 - lineOffset;

      let tileIdx = s.tile;
      if (height === 16) {
        tileIdx &= 0xFE;
        if (lineOffset >= 8) { tileIdx++; lineOffset -= 8; }
      }

      let pal = (s.flags & 0x10) ? this.io[0x49] : this.io[0x48];
      let addr = tileIdx * 16 + lineOffset * 2;
      let lo = this.vram[addr];
      let hi = this.vram[addr + 1];

      for (let bit = 0; bit < 8; bit++) {
        let px = s.x + (s.flags & 0x20 ? 7 - bit : bit);
        if (px < 0 || px >= 160) continue;

        let color = ((hi >> (7 - bit)) & 1) << 1 | ((lo >> (7 - bit)) & 1);
        if (color === 0) continue;

        if (s.flags & 0x80) {
          // OBJ behind BG: only draw if BG color index is 0
          if (this.bgColorIdx[px] !== 0) continue;
        }

        this.putPixel(px, ly, (pal >> (color * 2)) & 3);
      }
    }
  }

  handleInterrupts() {
    let pending = this.interruptFlags & this.ie & 0x1F;
    let anyFlag = this.interruptFlags & 0x1F;

    if (this.halted && anyFlag) {
      this.halted = false;
    }

    if (this.halted) return;
    if (!pending) return;
    if (!this.ime) return;
    this.ime = false;

    for (let i = 0; i < 5; i++) {
      if (pending & (1 << i)) {
        this.interruptFlags &= ~(1 << i);
        this.sp = (this.sp - 1) & 0xFFFF;
        this.write(this.sp, this.pc >> 8);
        this.sp = (this.sp - 1) & 0xFFFF;
        this.write(this.sp, this.pc & 0xFF);
        this.pc = 0x40 + i * 8;
        this.tick(20);
        return;
      }
    }
  }

  step() {
    if (this.stopped) { this.tick(4); return; }
    this.handleInterrupts();
    if (this.halted) { this.tick(4); return; }

    // IME pending (EI)
    if (this.imePending) { this.ime = true; this.imePending = false; }

    let op = this.read(this.pc);
    let op16 = op;
    if (op === 0xCB) {
      op16 = (op << 8) | this.read((this.pc + 1) & 0xFFFF);
    }

    this.executeOpcode(op, op16);
  }

  executeOpcode(op, op16) {
    let pc = this.pc;
    let r = this.read.bind(this);
    let w = this.write.bind(this);
    let t = this.tick.bind(this);

    // Helper
    let nextPC = (pc + 1) & 0xFFFF;
    let imm8 = () => r(nextPC);
    let imm16 = () => r(nextPC) | (r((nextPC + 1) & 0xFFFF) << 8);
    let condJump = (flag, value) => {
      if (flag) {
        let offset = r(nextPC);
        // Jump relative: offset is signed
        this.pc = (this.pc + 2 + ((offset << 24) >> 24)) & 0xFFFF;
        t(12);
      } else {
        this.pc = (this.pc + 2) & 0xFFFF;
        t(8);
      }
    };

    switch (op) {
      // NOP
      case 0x00: this.pc = (this.pc + 1) & 0xFFFF; t(4); break;

      // LD r, n (8-bit loads)
      case 0x06: this.b = imm8(); this.pc = (this.pc + 2) & 0xFFFF; t(8); break;
      case 0x0E: this.c = imm8(); this.pc = (this.pc + 2) & 0xFFFF; t(8); break;
      case 0x16: this.d = imm8(); this.pc = (this.pc + 2) & 0xFFFF; t(8); break;
      case 0x1E: this.e = imm8(); this.pc = (this.pc + 2) & 0xFFFF; t(8); break;
      case 0x26: this.h = imm8(); this.pc = (this.pc + 2) & 0xFFFF; t(8); break;
      case 0x2E: this.l = imm8(); this.pc = (this.pc + 2) & 0xFFFF; t(8); break;
      case 0x3E: this.a = imm8(); this.pc = (this.pc + 2) & 0xFFFF; t(8); break;

      // LD r, r
      case 0x7F: this.a = this.a; this.pc = (this.pc + 1) & 0xFFFF; t(4); break;
      case 0x78: this.a = this.b; this.pc = (this.pc + 1) & 0xFFFF; t(4); break;
      case 0x79: this.a = this.c; this.pc = (this.pc + 1) & 0xFFFF; t(4); break;
      case 0x7A: this.a = this.d; this.pc = (this.pc + 1) & 0xFFFF; t(4); break;
      case 0x7B: this.a = this.e; this.pc = (this.pc + 1) & 0xFFFF; t(4); break;
      case 0x7C: this.a = this.h; this.pc = (this.pc + 1) & 0xFFFF; t(4); break;
      case 0x7D: this.a = this.l; this.pc = (this.pc + 1) & 0xFFFF; t(4); break;
      case 0x7E: this.a = r(this.hl()); this.pc = (this.pc + 1) & 0xFFFF; t(8); break;
      case 0x47: this.b = this.a; this.pc = (this.pc + 1) & 0xFFFF; t(4); break;
      case 0x40: this.b = this.b; this.pc = (this.pc + 1) & 0xFFFF; t(4); break;
      case 0x41: this.b = this.c; this.pc = (this.pc + 1) & 0xFFFF; t(4); break;
      case 0x42: this.b = this.d; this.pc = (this.pc + 1) & 0xFFFF; t(4); break;
      case 0x43: this.b = this.e; this.pc = (this.pc + 1) & 0xFFFF; t(4); break;
      case 0x44: this.b = this.h; this.pc = (this.pc + 1) & 0xFFFF; t(4); break;
      case 0x45: this.b = this.l; this.pc = (this.pc + 1) & 0xFFFF; t(4); break;
      case 0x46: this.b = r(this.hl()); this.pc = (this.pc + 1) & 0xFFFF; t(8); break;
      case 0x4F: this.c = this.a; this.pc = (this.pc + 1) & 0xFFFF; t(4); break;
      case 0x48: this.c = this.b; this.pc = (this.pc + 1) & 0xFFFF; t(4); break;
      case 0x49: this.c = this.c; this.pc = (this.pc + 1) & 0xFFFF; t(4); break;
      case 0x4A: this.c = this.d; this.pc = (this.pc + 1) & 0xFFFF; t(4); break;
      case 0x4B: this.c = this.e; this.pc = (this.pc + 1) & 0xFFFF; t(4); break;
      case 0x4C: this.c = this.h; this.pc = (this.pc + 1) & 0xFFFF; t(4); break;
      case 0x4D: this.c = this.l; this.pc = (this.pc + 1) & 0xFFFF; t(4); break;
      case 0x4E: this.c = r(this.hl()); this.pc = (this.pc + 1) & 0xFFFF; t(8); break;
      case 0x57: this.d = this.a; this.pc = (this.pc + 1) & 0xFFFF; t(4); break;
      case 0x50: this.d = this.b; this.pc = (this.pc + 1) & 0xFFFF; t(4); break;
      case 0x51: this.d = this.c; this.pc = (this.pc + 1) & 0xFFFF; t(4); break;
      case 0x52: this.d = this.d; this.pc = (this.pc + 1) & 0xFFFF; t(4); break;
      case 0x53: this.d = this.e; this.pc = (this.pc + 1) & 0xFFFF; t(4); break;
      case 0x54: this.d = this.h; this.pc = (this.pc + 1) & 0xFFFF; t(4); break;
      case 0x55: this.d = this.l; this.pc = (this.pc + 1) & 0xFFFF; t(4); break;
      case 0x56: this.d = r(this.hl()); this.pc = (this.pc + 1) & 0xFFFF; t(8); break;
      case 0x5F: this.e = this.a; this.pc = (this.pc + 1) & 0xFFFF; t(4); break;
      case 0x58: this.e = this.b; this.pc = (this.pc + 1) & 0xFFFF; t(4); break;
      case 0x59: this.e = this.c; this.pc = (this.pc + 1) & 0xFFFF; t(4); break;
      case 0x5A: this.e = this.d; this.pc = (this.pc + 1) & 0xFFFF; t(4); break;
      case 0x5B: this.e = this.e; this.pc = (this.pc + 1) & 0xFFFF; t(4); break;
      case 0x5C: this.e = this.h; this.pc = (this.pc + 1) & 0xFFFF; t(4); break;
      case 0x5D: this.e = this.l; this.pc = (this.pc + 1) & 0xFFFF; t(4); break;
      case 0x5E: this.e = r(this.hl()); this.pc = (this.pc + 1) & 0xFFFF; t(8); break;
      case 0x67: this.h = this.a; this.pc = (this.pc + 1) & 0xFFFF; t(4); break;
      case 0x60: this.h = this.b; this.pc = (this.pc + 1) & 0xFFFF; t(4); break;
      case 0x61: this.h = this.c; this.pc = (this.pc + 1) & 0xFFFF; t(4); break;
      case 0x62: this.h = this.d; this.pc = (this.pc + 1) & 0xFFFF; t(4); break;
      case 0x63: this.h = this.e; this.pc = (this.pc + 1) & 0xFFFF; t(4); break;
      case 0x64: this.h = this.h; this.pc = (this.pc + 1) & 0xFFFF; t(4); break;
      case 0x65: this.h = this.l; this.pc = (this.pc + 1) & 0xFFFF; t(4); break;
      case 0x66: this.h = r(this.hl()); this.pc = (this.pc + 1) & 0xFFFF; t(8); break;
      case 0x6F: this.l = this.a; this.pc = (this.pc + 1) & 0xFFFF; t(4); break;
      case 0x68: this.l = this.b; this.pc = (this.pc + 1) & 0xFFFF; t(4); break;
      case 0x69: this.l = this.c; this.pc = (this.pc + 1) & 0xFFFF; t(4); break;
      case 0x6A: this.l = this.d; this.pc = (this.pc + 1) & 0xFFFF; t(4); break;
      case 0x6B: this.l = this.e; this.pc = (this.pc + 1) & 0xFFFF; t(4); break;
      case 0x6C: this.l = this.h; this.pc = (this.pc + 1) & 0xFFFF; t(4); break;
      case 0x6D: this.l = this.l; this.pc = (this.pc + 1) & 0xFFFF; t(4); break;
      case 0x6E: this.l = r(this.hl()); this.pc = (this.pc + 1) & 0xFFFF; t(8); break;
      case 0x70: w(this.hl(), this.b); this.pc = (this.pc + 1) & 0xFFFF; t(8); break;
      case 0x71: w(this.hl(), this.c); this.pc = (this.pc + 1) & 0xFFFF; t(8); break;
      case 0x72: w(this.hl(), this.d); this.pc = (this.pc + 1) & 0xFFFF; t(8); break;
      case 0x73: w(this.hl(), this.e); this.pc = (this.pc + 1) & 0xFFFF; t(8); break;
      case 0x74: w(this.hl(), this.h); this.pc = (this.pc + 1) & 0xFFFF; t(8); break;
      case 0x75: w(this.hl(), this.l); this.pc = (this.pc + 1) & 0xFFFF; t(8); break;
      case 0x36: w(this.hl(), imm8()); this.pc = (this.pc + 2) & 0xFFFF; t(12); break;

      // LD A, (nn)
      case 0x0A: this.a = r(this.bc()); this.pc = (this.pc + 1) & 0xFFFF; t(8); break;
      case 0x1A: this.a = r(this.de()); this.pc = (this.pc + 1) & 0xFFFF; t(8); break;
      case 0xFA: { let addr = imm16(); this.pc = (this.pc + 3) & 0xFFFF; this.a = r(addr); t(16); break; }
      case 0x3A: this.a = r(this.hl()); this.hl(dec16(this.hl())); this.pc = (this.pc + 1) & 0xFFFF; t(8); break;
      case 0x2A: this.a = r(this.hl()); this.hl(inc16(this.hl())); this.pc = (this.pc + 1) & 0xFFFF; t(8); break;

      // LD (nn), A
      case 0x02: w(this.bc(), this.a); this.pc = (this.pc + 1) & 0xFFFF; t(8); break;
      case 0x12: w(this.de(), this.a); this.pc = (this.pc + 1) & 0xFFFF; t(8); break;
      case 0xEA: { let addr = imm16(); this.pc = (this.pc + 3) & 0xFFFF; w(addr, this.a); t(16); break; }
      case 0x32: w(this.hl(), this.a); this.hl(dec16(this.hl())); this.pc = (this.pc + 1) & 0xFFFF; t(8); break;
      case 0x22: w(this.hl(), this.a); this.hl(inc16(this.hl())); this.pc = (this.pc + 1) & 0xFFFF; t(8); break;

      // LD (C), A
      case 0xE2: w(0xFF00 | this.c, this.a); this.pc = (this.pc + 1) & 0xFFFF; t(8); break;
      // LD A, (C)
      case 0xF2: this.a = r(0xFF00 | this.c); this.pc = (this.pc + 1) & 0xFFFF; t(8); break;

      // LD (n), A
      case 0xE0: w(0xFF00 | imm8(), this.a); this.pc = (this.pc + 2) & 0xFFFF; t(12); break;
      // LD A, (n)
      case 0xF0: this.a = r(0xFF00 | imm8()); this.pc = (this.pc + 2) & 0xFFFF; t(12); break;

      // LD (nn), SP
      case 0x08: { let addr = imm16(); w(addr, this.sp & 0xFF); w((addr + 1) & 0xFFFF, this.sp >> 8); this.pc = (this.pc + 3) & 0xFFFF; t(20); break; }

      // LD SP, HL
      case 0xF9: this.sp = this.hl(); this.pc = (this.pc + 1) & 0xFFFF; t(8); break;

      // LD HL, SP+e
      case 0xF8: {
        let offset = imm8();
        let e = (offset << 24) >> 24;
        let res = (this.sp + e) & 0xFFFF;
        this.f = 0;
        if ((this.sp ^ e ^ res) & 0x100) this.f |= 0x10;
        if ((this.sp ^ e ^ res) & 0x10) this.f |= 0x20;
        this.hl(res);
        this.pc = (this.pc + 2) & 0xFFFF; t(12); break;
      }

      // LD rr, nn (16-bit)
      case 0x01: this.bc(imm16()); this.pc = (this.pc + 3) & 0xFFFF; t(12); break;
      case 0x11: this.de(imm16()); this.pc = (this.pc + 3) & 0xFFFF; t(12); break;
      case 0x21: this.hl(imm16()); this.pc = (this.pc + 3) & 0xFFFF; t(12); break;
      case 0x31: this.sp = imm16(); this.pc = (this.pc + 3) & 0xFFFF; t(12); break;

      // PUSH
      case 0xF5: this.sp = (this.sp - 1) & 0xFFFF; w(this.sp, this.a); this.sp = (this.sp - 1) & 0xFFFF; w(this.sp, this.f); this.pc = (this.pc + 1) & 0xFFFF; t(16); break;
      case 0xC5: this.sp = (this.sp - 1) & 0xFFFF; w(this.sp, this.b); this.sp = (this.sp - 1) & 0xFFFF; w(this.sp, this.c); this.pc = (this.pc + 1) & 0xFFFF; t(16); break;
      case 0xD5: this.sp = (this.sp - 1) & 0xFFFF; w(this.sp, this.d); this.sp = (this.sp - 1) & 0xFFFF; w(this.sp, this.e); this.pc = (this.pc + 1) & 0xFFFF; t(16); break;
      case 0xE5: this.sp = (this.sp - 1) & 0xFFFF; w(this.sp, this.h); this.sp = (this.sp - 1) & 0xFFFF; w(this.sp, this.l); this.pc = (this.pc + 1) & 0xFFFF; t(16); break;

      // POP
      case 0xF1: this.f = r(this.sp) & 0xF0; this.sp = (this.sp + 1) & 0xFFFF; this.a = r(this.sp); this.sp = (this.sp + 1) & 0xFFFF; this.pc = (this.pc + 1) & 0xFFFF; t(12); break;
      case 0xC1: this.c = r(this.sp); this.sp = (this.sp + 1) & 0xFFFF; this.b = r(this.sp); this.sp = (this.sp + 1) & 0xFFFF; this.pc = (this.pc + 1) & 0xFFFF; t(12); break;
      case 0xD1: this.e = r(this.sp); this.sp = (this.sp + 1) & 0xFFFF; this.d = r(this.sp); this.sp = (this.sp + 1) & 0xFFFF; this.pc = (this.pc + 1) & 0xFFFF; t(12); break;
      case 0xE1: this.l = r(this.sp); this.sp = (this.sp + 1) & 0xFFFF; this.h = r(this.sp); this.sp = (this.sp + 1) & 0xFFFF; this.pc = (this.pc + 1) & 0xFFFF; t(12); break;

      // ADD A, r
      case 0x87: this.add(this.a); this.pc = nextPC; t(4); break;
      case 0x80: this.add(this.b); this.pc = nextPC; t(4); break;
      case 0x81: this.add(this.c); this.pc = nextPC; t(4); break;
      case 0x82: this.add(this.d); this.pc = nextPC; t(4); break;
      case 0x83: this.add(this.e); this.pc = nextPC; t(4); break;
      case 0x84: this.add(this.h); this.pc = nextPC; t(4); break;
      case 0x85: this.add(this.l); this.pc = nextPC; t(4); break;
      case 0x86: this.add(r(this.hl())); this.pc = nextPC; t(8); break;
      case 0xC6: this.add(imm8()); this.pc = (this.pc + 2) & 0xFFFF; t(8); break;

      // ADC A, r
      case 0x8F: this.adc(this.a); this.pc = nextPC; t(4); break;
      case 0x88: this.adc(this.b); this.pc = nextPC; t(4); break;
      case 0x89: this.adc(this.c); this.pc = nextPC; t(4); break;
      case 0x8A: this.adc(this.d); this.pc = nextPC; t(4); break;
      case 0x8B: this.adc(this.e); this.pc = nextPC; t(4); break;
      case 0x8C: this.adc(this.h); this.pc = nextPC; t(4); break;
      case 0x8D: this.adc(this.l); this.pc = nextPC; t(4); break;
      case 0x8E: this.adc(r(this.hl())); this.pc = nextPC; t(8); break;
      case 0xCE: this.adc(imm8()); this.pc = (this.pc + 2) & 0xFFFF; t(8); break;

      // SUB r
      case 0x97: this.sub(this.a); this.pc = nextPC; t(4); break;
      case 0x90: this.sub(this.b); this.pc = nextPC; t(4); break;
      case 0x91: this.sub(this.c); this.pc = nextPC; t(4); break;
      case 0x92: this.sub(this.d); this.pc = nextPC; t(4); break;
      case 0x93: this.sub(this.e); this.pc = nextPC; t(4); break;
      case 0x94: this.sub(this.h); this.pc = nextPC; t(4); break;
      case 0x95: this.sub(this.l); this.pc = nextPC; t(4); break;
      case 0x96: this.sub(r(this.hl())); this.pc = nextPC; t(8); break;
      case 0xD6: this.sub(imm8()); this.pc = (this.pc + 2) & 0xFFFF; t(8); break;

      // SBC A, r
      case 0x9F: this.sbc(this.a); this.pc = nextPC; t(4); break;
      case 0x98: this.sbc(this.b); this.pc = nextPC; t(4); break;
      case 0x99: this.sbc(this.c); this.pc = nextPC; t(4); break;
      case 0x9A: this.sbc(this.d); this.pc = nextPC; t(4); break;
      case 0x9B: this.sbc(this.e); this.pc = nextPC; t(4); break;
      case 0x9C: this.sbc(this.h); this.pc = nextPC; t(4); break;
      case 0x9D: this.sbc(this.l); this.pc = nextPC; t(4); break;
      case 0x9E: this.sbc(r(this.hl())); this.pc = nextPC; t(8); break;
      case 0xDE: this.sbc(imm8()); this.pc = (this.pc + 2) & 0xFFFF; t(8); break;

      // AND r
      case 0xA7: this.and(this.a); this.pc = nextPC; t(4); break;
      case 0xA0: this.and(this.b); this.pc = nextPC; t(4); break;
      case 0xA1: this.and(this.c); this.pc = nextPC; t(4); break;
      case 0xA2: this.and(this.d); this.pc = nextPC; t(4); break;
      case 0xA3: this.and(this.e); this.pc = nextPC; t(4); break;
      case 0xA4: this.and(this.h); this.pc = nextPC; t(4); break;
      case 0xA5: this.and(this.l); this.pc = nextPC; t(4); break;
      case 0xA6: this.and(r(this.hl())); this.pc = nextPC; t(8); break;
      case 0xE6: this.and(imm8()); this.pc = (this.pc + 2) & 0xFFFF; t(8); break;

      // XOR r
      case 0xAF: this.xor(this.a); this.pc = nextPC; t(4); break;
      case 0xA8: this.xor(this.b); this.pc = nextPC; t(4); break;
      case 0xA9: this.xor(this.c); this.pc = nextPC; t(4); break;
      case 0xAA: this.xor(this.d); this.pc = nextPC; t(4); break;
      case 0xAB: this.xor(this.e); this.pc = nextPC; t(4); break;
      case 0xAC: this.xor(this.h); this.pc = nextPC; t(4); break;
      case 0xAD: this.xor(this.l); this.pc = nextPC; t(4); break;
      case 0xAE: this.xor(r(this.hl())); this.pc = nextPC; t(8); break;
      case 0xEE: this.xor(imm8()); this.pc = (this.pc + 2) & 0xFFFF; t(8); break;

      // OR r
      case 0xB7: this.or(this.a); this.pc = nextPC; t(4); break;
      case 0xB0: this.or(this.b); this.pc = nextPC; t(4); break;
      case 0xB1: this.or(this.c); this.pc = nextPC; t(4); break;
      case 0xB2: this.or(this.d); this.pc = nextPC; t(4); break;
      case 0xB3: this.or(this.e); this.pc = nextPC; t(4); break;
      case 0xB4: this.or(this.h); this.pc = nextPC; t(4); break;
      case 0xB5: this.or(this.l); this.pc = nextPC; t(4); break;
      case 0xB6: this.or(r(this.hl())); this.pc = nextPC; t(8); break;
      case 0xF6: this.or(imm8()); this.pc = (this.pc + 2) & 0xFFFF; t(8); break;

      // CP r
      case 0xBF: this.cp(this.a); this.pc = nextPC; t(4); break;
      case 0xB8: this.cp(this.b); this.pc = nextPC; t(4); break;
      case 0xB9: this.cp(this.c); this.pc = nextPC; t(4); break;
      case 0xBA: this.cp(this.d); this.pc = nextPC; t(4); break;
      case 0xBB: this.cp(this.e); this.pc = nextPC; t(4); break;
      case 0xBC: this.cp(this.h); this.pc = nextPC; t(4); break;
      case 0xBD: this.cp(this.l); this.pc = nextPC; t(4); break;
      case 0xBE: this.cp(r(this.hl())); this.pc = nextPC; t(8); break;
      case 0xFE: this.cp(imm8()); this.pc = (this.pc + 2) & 0xFFFF; t(8); break;

      // INC r
      case 0x3C: this.a = this.inc8(this.a); this.pc = nextPC; t(4); break;
      case 0x04: this.b = this.inc8(this.b); this.pc = nextPC; t(4); break;
      case 0x0C: this.c = this.inc8(this.c); this.pc = nextPC; t(4); break;
      case 0x14: this.d = this.inc8(this.d); this.pc = nextPC; t(4); break;
      case 0x1C: this.e = this.inc8(this.e); this.pc = nextPC; t(4); break;
      case 0x24: this.h = this.inc8(this.h); this.pc = nextPC; t(4); break;
      case 0x2C: this.l = this.inc8(this.l); this.pc = nextPC; t(4); break;
      case 0x34: w(this.hl(), this.inc8(r(this.hl()))); this.pc = nextPC; t(12); break;

      // DEC r
      case 0x3D: this.a = this.dec8(this.a); this.pc = nextPC; t(4); break;
      case 0x05: this.b = this.dec8(this.b); this.pc = nextPC; t(4); break;
      case 0x0D: this.c = this.dec8(this.c); this.pc = nextPC; t(4); break;
      case 0x15: this.d = this.dec8(this.d); this.pc = nextPC; t(4); break;
      case 0x1D: this.e = this.dec8(this.e); this.pc = nextPC; t(4); break;
      case 0x25: this.h = this.dec8(this.h); this.pc = nextPC; t(4); break;
      case 0x2D: this.l = this.dec8(this.l); this.pc = nextPC; t(4); break;
      case 0x35: w(this.hl(), this.dec8(r(this.hl()))); this.pc = nextPC; t(12); break;

      // INC rr
      case 0x03: this.bc(inc16(this.bc())); this.pc = nextPC; t(8); break;
      case 0x13: this.de(inc16(this.de())); this.pc = nextPC; t(8); break;
      case 0x23: this.hl(inc16(this.hl())); this.pc = nextPC; t(8); break;
      case 0x33: this.sp = inc16(this.sp); this.pc = nextPC; t(8); break;

      // DEC rr
      case 0x0B: this.bc(dec16(this.bc())); this.pc = nextPC; t(8); break;
      case 0x1B: this.de(dec16(this.de())); this.pc = nextPC; t(8); break;
      case 0x2B: this.hl(dec16(this.hl())); this.pc = nextPC; t(8); break;
      case 0x3B: this.sp = dec16(this.sp); this.pc = nextPC; t(8); break;

      // ADD HL, rr
      case 0x09: this.addHL(this.bc()); this.pc = nextPC; t(8); break;
      case 0x19: this.addHL(this.de()); this.pc = nextPC; t(8); break;
      case 0x29: this.addHL(this.hl()); this.pc = nextPC; t(8); break;
      case 0x39: this.addHL(this.sp); this.pc = nextPC; t(8); break;

      // ADD SP, e
      case 0xE8: {
        let offset = imm8();
        let e = (offset << 24) >> 24;
        let res = (this.sp + e) & 0xFFFF;
        this.f = 0;
        if ((this.sp ^ e ^ res) & 0x100) this.f |= 0x10;
        if ((this.sp ^ e ^ res) & 0x10) this.f |= 0x20;
        this.sp = res;
        this.pc = (this.pc + 2) & 0xFFFF; t(16); break;
      }

      // DAA
      case 0x27: {
        let a = this.a; let f = this.f; let adjust = 0;
        if ((f & 0x20) || (!(f & 0x40) && (a & 0x0F) > 9)) adjust |= 0x06;
        if ((f & 0x10) || (!(f & 0x40) && a > 0x99)) adjust |= 0x60;
        if (f & 0x40) { this.a = (a - adjust) & 0xFF; this.f = 0x40 | ((a === this.a) ? 0x80 : 0); }
        else { this.a = (a + adjust) & 0xFF; this.f = (this.a === 0 ? 0x80 : 0); }
        if (adjust & 0x60) this.f |= 0x10;
        this.pc = nextPC; t(4); break;
      }

      // CPL
      case 0x2F: this.a = (~this.a) & 0xFF; this.f |= 0x60; this.pc = nextPC; t(4); break;
      // CCF
      case 0x3F: this.f = (this.f & 0x90) | ((this.f & 0x10) ? 0x20 : 0x10); this.pc = nextPC; t(4); break;
      // SCF
      case 0x37: this.f = (this.f & 0x80) | 0x10; this.pc = nextPC; t(4); break;

      // RLCA
      case 0x07: { let c = (this.a >> 7) & 1; this.a = ((this.a << 1) | c) & 0xFF; this.f = (this.f & 0x80) | (c ? 0x10 : 0); this.pc = nextPC; t(4); break; }
      // RLA
      case 0x17: { let c = (this.a >> 7) & 1; this.a = ((this.a << 1) | ((this.f & 0x10) ? 1 : 0)) & 0xFF; this.f = (this.f & 0x80) | (c ? 0x10 : 0); this.pc = nextPC; t(4); break; }
      // RRCA
      case 0x0F: { let c = this.a & 1; this.a = (this.a >> 1) | (c << 7); this.f = (this.f & 0x80) | (c ? 0x10 : 0); this.pc = nextPC; t(4); break; }
      // RRA
      case 0x1F: { let c = this.a & 1; this.a = (this.a >> 1) | ((this.f & 0x10) ? 0x80 : 0); this.f = (this.f & 0x80) | (c ? 0x10 : 0); this.pc = nextPC; t(4); break; }

      // JP nn
      case 0xC3: this.pc = imm16(); t(16); break;
      // JP (HL)
      case 0xE9: this.pc = this.hl(); t(4); break;

      // JP cc, nn
      case 0xC2: condJump(!this.getZ(), imm16()); break;
      case 0xCA: condJump(this.getZ(), imm16()); break;
      case 0xD2: condJump(!this.getC(), imm16()); break;
      case 0xDA: condJump(this.getC(), imm16()); break;

      // JR e
      case 0x18: { let offset = imm8(); this.pc = (this.pc + 2 + ((offset << 24) >> 24)) & 0xFFFF; t(12); break; }

      // JR cc, e
      case 0x20: condJump(!this.getZ(), 0); break;
      case 0x28: condJump(this.getZ(), 0); break;
      case 0x30: condJump(!this.getC(), 0); break;
      case 0x38: condJump(this.getC(), 0); break;

      // CALL nn
      case 0xCD: { let addr = imm16(); this.pc = (this.pc + 3) & 0xFFFF; this.sp = (this.sp - 1) & 0xFFFF; w(this.sp, this.pc >> 8); this.sp = (this.sp - 1) & 0xFFFF; w(this.sp, this.pc & 0xFF); this.pc = addr; t(24); break; }

      // CALL cc, nn
      case 0xC4: { let addr = imm16(); if (!this.getZ()) { this.pc = (this.pc + 3) & 0xFFFF; this.sp = (this.sp - 1) & 0xFFFF; w(this.sp, this.pc >> 8); this.sp = (this.sp - 1) & 0xFFFF; w(this.sp, this.pc & 0xFF); this.pc = addr; t(24); } else { this.pc = (this.pc + 3) & 0xFFFF; t(12); } break; }
      case 0xCC: { let addr = imm16(); if (this.getZ()) { this.pc = (this.pc + 3) & 0xFFFF; this.sp = (this.sp - 1) & 0xFFFF; w(this.sp, this.pc >> 8); this.sp = (this.sp - 1) & 0xFFFF; w(this.sp, this.pc & 0xFF); this.pc = addr; t(24); } else { this.pc = (this.pc + 3) & 0xFFFF; t(12); } break; }
      case 0xD4: { let addr = imm16(); if (!this.getC()) { this.pc = (this.pc + 3) & 0xFFFF; this.sp = (this.sp - 1) & 0xFFFF; w(this.sp, this.pc >> 8); this.sp = (this.sp - 1) & 0xFFFF; w(this.sp, this.pc & 0xFF); this.pc = addr; t(24); } else { this.pc = (this.pc + 3) & 0xFFFF; t(12); } break; }
      case 0xDC: { let addr = imm16(); if (this.getC()) { this.pc = (this.pc + 3) & 0xFFFF; this.sp = (this.sp - 1) & 0xFFFF; w(this.sp, this.pc >> 8); this.sp = (this.sp - 1) & 0xFFFF; w(this.sp, this.pc & 0xFF); this.pc = addr; t(24); } else { this.pc = (this.pc + 3) & 0xFFFF; t(12); } break; }

      // RET
      case 0xC9: { let lo = r(this.sp); this.sp = (this.sp + 1) & 0xFFFF; let hi = r(this.sp); this.sp = (this.sp + 1) & 0xFFFF; this.pc = (hi << 8) | lo; t(16); break; }
      // RETI
      case 0xD9: { let lo = r(this.sp); this.sp = (this.sp + 1) & 0xFFFF; let hi = r(this.sp); this.sp = (this.sp + 1) & 0xFFFF; this.pc = (hi << 8) | lo; this.ime = true; t(16); break; }

      // RET cc
      case 0xC0: if (!this.getZ()) { let lo = r(this.sp); this.sp = (this.sp + 1) & 0xFFFF; let hi = r(this.sp); this.sp = (this.sp + 1) & 0xFFFF; this.pc = (hi << 8) | lo; t(20); } else { this.pc = nextPC; t(8); } break;
      case 0xC8: if (this.getZ()) { let lo = r(this.sp); this.sp = (this.sp + 1) & 0xFFFF; let hi = r(this.sp); this.sp = (this.sp + 1) & 0xFFFF; this.pc = (hi << 8) | lo; t(20); } else { this.pc = nextPC; t(8); } break;
      case 0xD0: if (!this.getC()) { let lo = r(this.sp); this.sp = (this.sp + 1) & 0xFFFF; let hi = r(this.sp); this.sp = (this.sp + 1) & 0xFFFF; this.pc = (hi << 8) | lo; t(20); } else { this.pc = nextPC; t(8); } break;
      case 0xD8: if (this.getC()) { let lo = r(this.sp); this.sp = (this.sp + 1) & 0xFFFF; let hi = r(this.sp); this.sp = (this.sp + 1) & 0xFFFF; this.pc = (hi << 8) | lo; t(20); } else { this.pc = nextPC; t(8); } break;

      // RST
      case 0xC7: this.rst(0x00); t(16); break;
      case 0xCF: this.rst(0x08); t(16); break;
      case 0xD7: this.rst(0x10); t(16); break;
      case 0xDF: this.rst(0x18); t(16); break;
      case 0xE7: this.rst(0x20); t(16); break;
      case 0xEF: this.rst(0x28); t(16); break;
      case 0xF7: this.rst(0x30); t(16); break;
      case 0xFF: this.rst(0x38); t(16); break;

      // DI / EI
      case 0xF3: this.ime = false; this.pc = nextPC; t(4); break;
      case 0xFB: this.imePending = true; this.pc = nextPC; t(4); break;

      // HALT
      case 0x76: this.halted = true; this.pc = nextPC; t(4); break;

      // STOP
      case 0x10: this.stopped = true; this.pc = (this.pc + 2) & 0xFFFF; t(4); break;

      // CB prefix
      case 0xCB: this.executeCB(); break;

      default:
        console.error(`Unknown opcode 0x${op.toString(16).toUpperCase().padStart(2, '0')} at PC=0x${pc.toString(16).toUpperCase().padStart(4, '0')}`);
        this.pc = nextPC; t(4); break;
    }
  }

  getZ() { return !!(this.f & 0x80); }
  getC() { return !!(this.f & 0x10); }

  bc(v) { if (v !== undefined) { this.b = v >> 8; this.c = v & 0xFF; } return (this.b << 8) | this.c; }
  de(v) { if (v !== undefined) { this.d = v >> 8; this.e = v & 0xFF; } return (this.d << 8) | this.e; }
  hl(v) { if (v !== undefined) { this.h = v >> 8; this.l = v & 0xFF; } return (this.h << 8) | this.l; }

  add(v) { let r = this.a + v; this.f = ((r & 0xFF) === 0 ? 0x80 : 0) | ((r > 0xFF) ? 0x10 : 0) | (((this.a & 0xF) + (v & 0xF)) > 0xF ? 0x20 : 0); this.a = r & 0xFF; }
  adc(v) { let c = (this.f & 0x10) ? 1 : 0; let r = this.a + v + c; this.f = ((r & 0xFF) === 0 ? 0x80 : 0) | ((r > 0xFF) ? 0x10 : 0) | (((this.a & 0xF) + (v & 0xF) + c) > 0xF ? 0x20 : 0); this.a = r & 0xFF; }
  sub(v) { let r = this.a - v; this.f = 0x40 | ((r & 0xFF) === 0 ? 0x80 : 0) | ((r < 0) ? 0x10 : 0) | (((this.a & 0xF) - (v & 0xF)) < 0 ? 0x20 : 0); this.a = r & 0xFF; }
  sbc(v) { let c = (this.f & 0x10) ? 1 : 0; let r = this.a - v - c; this.f = 0x40 | ((r & 0xFF) === 0 ? 0x80 : 0) | ((r < 0) ? 0x10 : 0) | (((this.a & 0xF) - (v & 0xF) - c) < 0 ? 0x20 : 0); this.a = r & 0xFF; }
  and(v) { this.a &= v; this.f = (this.a === 0 ? 0x80 : 0) | 0x20; }
  xor(v) { this.a ^= v; this.f = (this.a === 0 ? 0x80 : 0); }
  or(v) { this.a |= v; this.f = (this.a === 0 ? 0x80 : 0); }
  cp(v) { let r = this.a - v; this.f = 0x40 | ((r & 0xFF) === 0 ? 0x80 : 0) | ((r < 0) ? 0x10 : 0) | (((this.a & 0xF) - (v & 0xF)) < 0 ? 0x20 : 0); }

  inc8(v) { let r = (v + 1) & 0xFF; this.f = (this.f & 0x10) | (r === 0 ? 0x80 : 0) | ((r & 0x0F) === 0 ? 0x20 : 0); return r; }
  dec8(v) { let r = (v - 1) & 0xFF; this.f = (this.f & 0x10) | 0x40 | (r === 0 ? 0x80 : 0) | ((r & 0x0F) === 0x0F ? 0x20 : 0); return r; }

  addHL(v) {
    let hl = (this.h << 8) | this.l;
    let r = hl + v;
    this.f = (this.f & 0x80) | ((r > 0xFFFF) ? 0x10 : 0) | (((hl & 0xFFF) + (v & 0xFFF)) > 0xFFF ? 0x20 : 0);
    this.h = (r >> 8) & 0xFF; this.l = r & 0xFF;
  }

  rst(vec) {
    this.sp = (this.sp - 1) & 0xFFFF; this.write(this.sp, ((this.pc + 1) >> 8) & 0xFF);
    this.sp = (this.sp - 1) & 0xFFFF; this.write(this.sp, (this.pc + 1) & 0xFF);
    this.pc = vec;
  }

  executeCB() {
    let op = this.read((this.pc + 1) & 0xFFFF);
    this.pc = (this.pc + 2) & 0xFFFF;
    let srcVal, dst;

    let reg = op & 0x07;
    let hiBits = (op >> 6) & 3; // 0=shift, 1=bit, 2=res, 3=set
    let midBits = (op >> 3) & 7; // operation

    // Get source value
    switch (reg) {
      case 0: srcVal = this.b; dst = 'b'; break;
      case 1: srcVal = this.c; dst = 'c'; break;
      case 2: srcVal = this.d; dst = 'd'; break;
      case 3: srcVal = this.e; dst = 'e'; break;
      case 4: srcVal = this.h; dst = 'h'; break;
      case 5: srcVal = this.l; dst = 'l'; break;
      case 6: srcVal = this.read((this.h << 8) | this.l); dst = 'hl'; break;
      case 7: srcVal = this.a; dst = 'a'; break;
    }

    let isHL = reg === 6;

    let writeBack = (v) => {
      switch (reg) {
        case 0: this.b = v; break; case 1: this.c = v; break;
        case 2: this.d = v; break; case 3: this.e = v; break;
        case 4: this.h = v; break; case 5: this.l = v; break;
        case 6: this.write((this.h << 8) | this.l, v); break;
        case 7: this.a = v; break;
      }
    };

    if (hiBits === 0) {
      // RLC, RRC, RL, RR, SLA, SRA, SWAP, SRL
      switch (midBits) {
        case 0: { // RLC
          let c = (srcVal >> 7) & 1;
          let r = ((srcVal << 1) | c) & 0xFF;
          this.f = (r === 0 ? 0x80 : 0) | (c ? 0x10 : 0);
          writeBack(r); break;
        }
        case 1: { // RRC
          let c = srcVal & 1;
          let r = (srcVal >> 1) | (c << 7);
          this.f = (r === 0 ? 0x80 : 0) | (c ? 0x10 : 0);
          writeBack(r); break;
        }
        case 2: { // RL
          let c = (srcVal >> 7) & 1;
          let r = ((srcVal << 1) | ((this.f & 0x10) ? 1 : 0)) & 0xFF;
          this.f = (r === 0 ? 0x80 : 0) | (c ? 0x10 : 0);
          writeBack(r); break;
        }
        case 3: { // RR
          let c = srcVal & 1;
          let r = (srcVal >> 1) | ((this.f & 0x10) ? 0x80 : 0);
          this.f = (r === 0 ? 0x80 : 0) | (c ? 0x10 : 0);
          writeBack(r); break;
        }
        case 4: { // SLA
          let c = (srcVal >> 7) & 1;
          let r = (srcVal << 1) & 0xFF;
          this.f = (r === 0 ? 0x80 : 0) | (c ? 0x10 : 0);
          writeBack(r); break;
        }
        case 5: { // SRA
          let c = srcVal & 1;
          let r = (srcVal >> 1) | (srcVal & 0x80);
          this.f = (r === 0 ? 0x80 : 0) | (c ? 0x10 : 0);
          writeBack(r); break;
        }
        case 6: { // SWAP
          let r = ((srcVal & 0x0F) << 4) | ((srcVal >> 4) & 0x0F);
          this.f = (r === 0 ? 0x80 : 0);
          writeBack(r); break;
        }
        case 7: { // SRL
          let c = srcVal & 1;
          let r = srcVal >> 1;
          this.f = (r === 0 ? 0x80 : 0) | (c ? 0x10 : 0);
          writeBack(r); break;
        }
      }
      this.tick(isHL ? 16 : 8);
    } else if (hiBits === 1) {
      // BIT
      let bit = midBits;
      this.f = (this.f & 0x10) | 0x20 | ((srcVal & (1 << bit)) ? 0 : 0x80);
      this.tick(isHL ? 12 : 8);
    } else if (hiBits === 2) {
      // RES
      writeBack(srcVal & ~(1 << midBits));
      this.tick(isHL ? 16 : 8);
    } else {
      // SET
      writeBack(srcVal | (1 << midBits));
      this.tick(isHL ? 16 : 8);
    }
  }
}

// Run dmg-acid2
const rom = fs.readFileSync('/Users/junchengliao/Desktop/Test deepseekv4/dmg-acid2.gb');
const gb = new GameBoy();
gb.loadROM(rom);

// Run for 300 frames to let the test complete
for (let frame = 0; frame < 300; frame++) {
  gb.systemCycles = 0;
  while (gb.systemCycles < CYCLES_PER_FRAME) {
    gb.step();
  }
}

// === DIAGNOSTIC ===
console.log("=== OAM dump (first 20 entries) ===");
for (let i = 0; i < 20; i++) {
  let y = gb.oam[i*4], x = gb.oam[i*4+1], tile = gb.oam[i*4+2], flags = gb.oam[i*4+3];
  console.log("  OAM[" + i + "]: Y=" + y + " scrY=" + (y-16) + " X=" + x + " scrX=" + (x-8) + " Tile=" + tile + " Flg=0b" + flags.toString(2).padStart(8,'0'));
}

console.log("\n=== Tile data dump (tiles 72='H', 101='e', 108='l', 87='W') ===");
[72,101,108,87,111,114,100].forEach(tidx => {
  console.log("Tile " + tidx + " ('" + String.fromCharCode(tidx) + "'):");
  let addr = tidx * 16;
  for (let row = 0; row < 8; row++) {
    let lo = gb.vram[addr + row * 2], hi = gb.vram[addr + row * 2 + 1];
    let line = "";
    for (let bit = 7; bit >= 0; bit--) {
      let c = ((hi >> bit) & 1) << 1 | ((lo >> bit) & 1);
      line += c === 0 ? " " : c === 1 ? "." : c === 2 ? "*" : "#";
    }
    console.log("  " + line);
  }
});

// Check pixels at scanline 4 (where "Hello" sprites should be)
console.log("\n=== Pixel dump at scanline 4 (X=35..125) ===");
let line4 = "";
for (let x = 35; x < 125; x++) {
  let i = (4 * 160 + x) * 4;
  let r = gb.frameBuffer[i], g = gb.frameBuffer[i+1], b = gb.frameBuffer[i+2];
  let ci = 0;
  if (r < 50 && g < 50 && b < 50) ci = 3;
  else if (r < 50 && g < 120) ci = 2;
  else if (g < 150) ci = 1;
  line4 += ci === 0 ? " " : ci === 1 ? "." : ci === 2 ? "*" : "#";
}
console.log("  " + line4);

// Also check bgColorIdx at scanline 4
console.log("=== bgColorIdx at scanline 4 (X=35..125) ===");
line4 = "";
for (let x = 35; x < 125; x++) {
  let ci = gb.bgColorIdx[x];
  line4 += ci === 0 ? " " : ci === 1 ? "." : ci === 2 ? "*" : "#";
}
console.log("  " + line4);

// Save framebuffer as PPM (easier to write than PNG)
let ppm = `P3\n160 144\n255\n`;
for (let y = 0; y < 144; y++) {
  for (let x = 0; x < 160; x++) {
    let i = (y * 160 + x) * 4;
    ppm += `${gb.frameBuffer[i]} ${gb.frameBuffer[i+1]} ${gb.frameBuffer[i+2]} `;
  }
  ppm += '\n';
}
fs.writeFileSync('/Users/junchengliao/Desktop/Test deepseekv4/acid2-output.ppm', ppm);

console.log('dmg-acid2 test completed');
console.log('LCDC:', gb.io[0x40].toString(16));
console.log('STAT:', gb.io[0x41].toString(16));
console.log('SCY:', gb.io[0x42], 'SCX:', gb.io[0x43]);
console.log('LY:', gb.scanline);
console.log('BGP:', gb.io[0x47].toString(16));
console.log('OBP0:', gb.io[0x48].toString(16));
console.log('OBP1:', gb.io[0x49].toString(16));
console.log('IE:', gb.ie.toString(16));
console.log('IF:', gb.interruptFlags.toString(16));
console.log('IME:', gb.ime);
console.log('LCDC bit 1 (OBJ):', !!(gb.io[0x40] & 0x02));

// Check VRAM for tile data
let nonZeroVRAM = 0;
for (let i = 0; i < 0x2000; i++) if (gb.vram[i] !== 0) nonZeroVRAM++;
console.log('Non-zero VRAM bytes:', nonZeroVRAM);

// Check OAM
let activeSprites = 0;
for (let i = 0; i < 40; i++) {
  if (gb.oam[i*4] !== 0 || gb.oam[i*4+1] !== 0 || gb.oam[i*4+2] !== 0 || gb.oam[i*4+3] !== 0) activeSprites++;
}
console.log('Active sprites in OAM:', activeSprites);

// Print some OAM entries
console.log('First 5 OAM entries:');
for (let i = 0; i < 5; i++) {
  console.log(`  [${i}]: Y=${gb.oam[i*4]}, X=${gb.oam[i*4+1]}, Tile=${gb.oam[i*4+2]}, Flags=${gb.oam[i*4+3].toString(2).padStart(8,'0')}`);
}

console.log('Framebuffer saved to acid2-output.ppm');
