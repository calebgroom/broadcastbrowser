// DeckLink (Blackmagic Desktop Video) output for Broadcast Browser: frames from
// the app (BGRA, 1920×1080) out of an UltraStudio / DeckLink device as SDI or HDMI, in scheduled
// playback, so the device's own clock paces the output.
//
//   list(modes)                    the devices Desktop Video finds (each output port of a card
//                                  with several is a device of its own: "DeckLink Duo 2 (3)"),
//                                  with whether each is in use by another app, and active in
//                                  the card's profile
//   apiVersion()                   Desktop Video's version, or null if it isn't installed
//   new Player(index, mode, onTick) open device `index` for output in `mode` (a BMDDisplayMode
//                                  four-character code, e.g. 'Hp59' = 1080p59.94); onTick() is
//                                  called (on the JS thread) each time the device finishes
//                                  showing a frame: the moment to push the next one
//   player.push(buffer)            a frame (BGRA, width × height × 4 bytes) to show next
//   player.pending()               frames pushed and waiting to be scheduled
//   player.stats()                 counts and state (see Stats below)
//   player.close()
//
// How it plays: PREROLL frames of black are scheduled and playback starts. Each time the device
// finishes a frame, the next one is scheduled straight away, on the device's thread: the oldest
// frame pushed, or the last one again if none is waiting (a repeat). Pushed frames are copied into
// a pool of device frames (converted to 8-bit YUV if the device can't take BGRA in this mode).
// If the timeline falls behind the device (frames late or dropped: the app was stalled), it jumps
// ahead to just after the device's current time.
//
// The SDK headers (sdk/Mac, sdk/Linux) are Blackmagic's, version 14.4; their dispatch code loads
// Desktop Video's library at run time, so this builds without Desktop Video installed and reports
// "not installed" when it isn't.

#define NAPI_VERSION 6
#include <napi.h>

#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <mutex>
#include <string>
#include <vector>

#include "DeckLinkAPI.h"

namespace {

constexpr int POOL = 10;     // device frames: enough for the scheduled ones, the waiting ones and the last
constexpr int PREROLL = 3;   // frames scheduled before playback starts (the device's buffer)
constexpr int MAX_PENDING = 3;

#ifdef __APPLE__
typedef CFStringRef DLString;
std::string toString(CFStringRef s) {
  if (!s) return "";
  std::string out;
  char buf[512];
  if (CFStringGetCString(s, buf, sizeof buf, kCFStringEncodingUTF8)) out = buf;
  CFRelease(s);
  return out;
}
bool sameIID(REFIID a, CFUUIDBytes b) { return memcmp(&a, &b, sizeof(REFIID)) == 0; }
#else
typedef const char* DLString;
std::string toString(const char* s) {
  if (!s) return "";
  std::string out(s);
  free((void*)s);
  return out;
}
bool sameIID(REFIID a, REFIID b) { return memcmp(&a, &b, sizeof(REFIID)) == 0; }
#endif

std::string fourcc(uint32_t v) {
  std::string s(4, ' ');
  for (int i = 0; i < 4; i++) s[i] = (char)((v >> (24 - 8 * i)) & 0xff);
  return s;
}

uint32_t fromFourcc(const std::string& s) {
  if (s.size() != 4) return 0;
  return ((uint32_t)(uint8_t)s[0] << 24) | ((uint32_t)(uint8_t)s[1] << 16) | ((uint32_t)(uint8_t)s[2] << 8) | (uint32_t)(uint8_t)s[3];
}

std::string hresult(HRESULT r) {
  char buf[32];
  snprintf(buf, sizeof buf, "0x%08x", (unsigned)r);
  return buf;
}

/** Every device Desktop Video knows (each AddRef'd: Release them). */
std::vector<IDeckLink*> devices() {
  std::vector<IDeckLink*> out;
  IDeckLinkIterator* it = CreateDeckLinkIteratorInstance();
  if (!it) return out;
  IDeckLink* d = nullptr;
  while (it->Next(&d) == S_OK) out.push_back(d);
  it->Release();
  return out;
}

/**
 * What a device is doing: whether another app is playing out of it (Desktop Video's busy state:
 * a port another app is capturing from is still free for output, on a full-duplex card), and its
 * duplex mode in the card's profile ("inactive": a port the profile doesn't use, e.g. the second
 * half of a full-duplex pair on a DeckLink Duo 2 or Quad 2; Desktop Video Setup sets it).
 */
struct DeviceState {
  bool playbackBusy = false;
  bool captureBusy = false;
  std::string duplex;  // full, half, simplex, inactive, or "" (the device doesn't say)
  int64_t persistentId = -1;
  int64_t subDevice = -1;
};
DeviceState deviceState(IDeckLink* d) {
  DeviceState st;
  IDeckLinkStatus* status = nullptr;
  if (d->QueryInterface(IID_IDeckLinkStatus, (void**)&status) == S_OK && status) {
    int64_t busy = 0;
    if (status->GetInt(bmdDeckLinkStatusBusy, &busy) == S_OK) {
      st.playbackBusy = (busy & bmdDevicePlaybackBusy) != 0;
      st.captureBusy = (busy & bmdDeviceCaptureBusy) != 0;
    }
    status->Release();
  }
  IDeckLinkProfileAttributes* attrs = nullptr;
  if (d->QueryInterface(IID_IDeckLinkProfileAttributes, (void**)&attrs) == S_OK && attrs) {
    int64_t v = 0;
    if (attrs->GetInt(BMDDeckLinkDuplex, &v) == S_OK)
      st.duplex = v == bmdDuplexFull ? "full" : v == bmdDuplexHalf ? "half" : v == bmdDuplexSimplex ? "simplex" : v == bmdDuplexInactive ? "inactive" : "";
    if (attrs->GetInt(BMDDeckLinkPersistentID, &v) == S_OK) st.persistentId = v;
    if (attrs->GetInt(BMDDeckLinkSubDeviceIndex, &v) == S_OK) st.subDevice = v;
    attrs->Release();
  }
  return st;
}

bool supports(IDeckLinkOutput* out, BMDDisplayMode mode, BMDPixelFormat format) {
  bool ok = false;
  BMDDisplayMode actual;
  if (out->DoesSupportVideoMode(bmdVideoConnectionUnspecified, mode, format, bmdNoVideoOutputConversion, bmdSupportedVideoModeDefault, &actual, &ok) != S_OK) return false;
  return ok;
}

Napi::Value ApiVersion(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  IDeckLinkAPIInformation* api = CreateDeckLinkAPIInformationInstance();
  if (!api) return env.Null();
  DLString s = nullptr;
  std::string v = api->GetString(BMDDeckLinkAPIVersion, &s) == S_OK ? toString(s) : "";
  api->Release();
  return Napi::String::New(env, v);
}

/** [{ index, name, model, output, modes: { 'Hp59': 'bgra' | 'yuv' | null, ... } }] for the modes asked about. */
Napi::Value List(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::vector<uint32_t> modes;
  if (info.Length() > 0 && info[0].IsArray()) {
    Napi::Array a = info[0].As<Napi::Array>();
    for (uint32_t i = 0; i < a.Length(); i++) modes.push_back(fromFourcc(a.Get(i).ToString().Utf8Value()));
  }
  std::vector<IDeckLink*> list = devices();
  Napi::Array result = Napi::Array::New(env, list.size());
  for (size_t i = 0; i < list.size(); i++) {
    IDeckLink* d = list[i];
    Napi::Object o = Napi::Object::New(env);
    DLString s = nullptr;
    o.Set("index", (double)i);
    o.Set("name", d->GetDisplayName(&s) == S_OK ? toString(s) : "");
    s = nullptr;
    o.Set("model", d->GetModelName(&s) == S_OK ? toString(s) : "");
    IDeckLinkOutput* out = nullptr;
    bool canOutput = d->QueryInterface(IID_IDeckLinkOutput, (void**)&out) == S_OK && out;
    o.Set("output", canOutput);
    DeviceState st = deviceState(d);
    o.Set("busy", st.playbackBusy);
    o.Set("capturing", st.captureBusy);
    o.Set("duplex", st.duplex.empty() ? env.Null() : Napi::String::New(env, st.duplex));
    o.Set("persistentId", st.persistentId < 0 ? env.Null() : Napi::Number::New(env, (double)st.persistentId));
    o.Set("subDevice", st.subDevice < 0 ? env.Null() : Napi::Number::New(env, (double)st.subDevice));
    Napi::Object m = Napi::Object::New(env);
    for (uint32_t mode : modes) {
      if (!canOutput) m.Set(fourcc(mode), env.Null());
      else if (supports(out, mode, bmdFormat8BitBGRA)) m.Set(fourcc(mode), "bgra");
      else if (supports(out, mode, bmdFormat8BitYUV)) m.Set(fourcc(mode), "yuv");
      else m.Set(fourcc(mode), env.Null());
    }
    o.Set("modes", m);
    if (out) out->Release();
    d->Release();
    result.Set((uint32_t)i, o);
  }
  return result;
}

/** BGRA → 8-bit 4:2:2 YUV ('2vuy': Cb Y0 Cr Y1), BT.709, video levels. */
void bgraToUyvy(const uint8_t* src, int srcStride, uint8_t* dst, int dstStride, int width, int height) {
  for (int y = 0; y < height; y++) {
    const uint8_t* s = src + (size_t)y * srcStride;
    uint8_t* d = dst + (size_t)y * dstStride;
    for (int x = 0; x + 1 < width; x += 2, s += 8, d += 4) {
      int b0 = s[0], g0 = s[1], r0 = s[2], b1 = s[4], g1 = s[5], r1 = s[6];
      int y0 = ((47 * r0 + 157 * g0 + 16 * b0 + 128) >> 8) + 16;
      int y1 = ((47 * r1 + 157 * g1 + 16 * b1 + 128) >> 8) + 16;
      int r = (r0 + r1) >> 1, g = (g0 + g1) >> 1, b = (b0 + b1) >> 1;
      int cb = ((-26 * r - 86 * g + 112 * b + 128) >> 8) + 128;  // (coefficients summing to 0: grey has no colour)
      int cr = ((112 * r - 102 * g - 10 * b + 128) >> 8) + 128;
      d[0] = (uint8_t)(cb < 16 ? 16 : cb > 240 ? 240 : cb);
      d[1] = (uint8_t)(y0 > 235 ? 235 : y0);
      d[2] = (uint8_t)(cr < 16 ? 16 : cr > 240 ? 240 : cr);
      d[3] = (uint8_t)(y1 > 235 ? 235 : y1);
    }
  }
}

class Player;

/** The device's callback: a scheduled frame has been shown (or dropped, or flushed). */
class Callback : public IDeckLinkVideoOutputCallback {
 public:
  explicit Callback(Player* p) : player(p) {}
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, LPVOID* ppv) override {
#ifdef __APPLE__
    CFUUIDBytes unknown = CFUUIDGetUUIDBytes(IUnknownUUID);
#else
    REFIID unknown = IID_IUnknown;
#endif
    if (sameIID(iid, unknown) || sameIID(iid, IID_IDeckLinkVideoOutputCallback)) {
      *ppv = this;
      AddRef();
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return ++refs; }
  ULONG STDMETHODCALLTYPE Release() override {
    ULONG n = --refs;
    if (n == 0) delete this;
    return n;
  }
  HRESULT STDMETHODCALLTYPE ScheduledFrameCompleted(IDeckLinkVideoFrame* frame, BMDOutputFrameCompletionResult result) override;
  HRESULT STDMETHODCALLTYPE ScheduledPlaybackHasStopped() override { return S_OK; }
  /** Cleared when the player closes (callbacks after that do nothing). */
  std::atomic<Player*> player;

 private:
  std::atomic<ULONG> refs{1};
};

struct Slot {
  IDeckLinkMutableVideoFrame* frame = nullptr;
  int scheduled = 0;   // times it's scheduled and not yet completed
  bool pending = false;
  bool writing = false;
};

class Player : public Napi::ObjectWrap<Player> {
 public:
  static Napi::Function Init(Napi::Env env) {
    return DefineClass(env, "Player",
                       {InstanceMethod("push", &Player::Push), InstanceMethod("pending", &Player::Pending), InstanceMethod("stats", &Player::Stats),
                        InstanceMethod("close", &Player::Close)});
  }

  Player(const Napi::CallbackInfo& info) : Napi::ObjectWrap<Player>(info) {
    Napi::Env env = info.Env();
    if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsString() || !info[2].IsFunction()) {
      Napi::TypeError::New(env, "new Player(index, mode, onTick)").ThrowAsJavaScriptException();
      return;
    }
    int index = info[0].As<Napi::Number>().Int32Value();
    mode = fromFourcc(info[1].As<Napi::String>().Utf8Value());
    std::string err = open(index);
    if (!err.empty()) {
      closeDevice();
      Napi::Error::New(env, err).ThrowAsJavaScriptException();
      return;
    }
    tick = Napi::ThreadSafeFunction::New(env, info[2].As<Napi::Function>(), "decklink tick", 8, 1);
    hasTick = true;
    err = start();
    if (!err.empty()) {
      closeDevice();
      Napi::Error::New(env, err).ThrowAsJavaScriptException();
    }
  }

  ~Player() { closeDevice(); }

  /** Called on the device's thread. */
  void completed(IDeckLinkVideoFrame* frame, BMDOutputFrameCompletionResult result) {
    {
      std::lock_guard<std::mutex> lock(mu);
      if (stopping) return;
      for (Slot& s : slots)
        if ((IDeckLinkVideoFrame*)s.frame == frame && s.scheduled > 0) {
          s.scheduled--;
          break;
        }
      completedCount++;
      if (result == bmdOutputFrameDisplayedLate) late++;
      else if (result == bmdOutputFrameDropped) dropped++;
      else if (result == bmdOutputFrameFlushed) return;
      if (result == bmdOutputFrameDisplayedLate || result == bmdOutputFrameDropped) catchUp();
      scheduleNext();
      // (The JS side's cue to push the next frame. Under the lock: close() can't release it meanwhile.)
      if (hasTick) tick.NonBlockingCall();
    }
  }

 private:
  std::string open(int index) {
    std::vector<IDeckLink*> list = devices();
    if (list.empty()) return "no DeckLink devices found (is Desktop Video installed, and the device connected?)";
    if (index < 0 || index >= (int)list.size()) {
      for (IDeckLink* d : list) d->Release();
      return "no DeckLink device " + std::to_string(index + 1) + " (found " + std::to_string(list.size()) + ")";
    }
    device = list[index];
    for (int i = 0; i < (int)list.size(); i++)
      if (i != index) list[i]->Release();
    DLString s = nullptr;
    name = device->GetDisplayName(&s) == S_OK ? toString(s) : "DeckLink";
    if (device->QueryInterface(IID_IDeckLinkOutput, (void**)&output) != S_OK || !output) {
      output = nullptr;
      return name + " has no video output";
    }
    DeviceState st = deviceState(device);
    if (st.duplex == "inactive") return name + " isn't active in the card's profile (Desktop Video Setup sets which ports are in use)";
    if (st.playbackBusy) return name + " is in use by another app (Media Express, OBS, vMix, another copy of this app)";
    if (supports(output, mode, bmdFormat8BitBGRA)) format = bmdFormat8BitBGRA;
    else if (supports(output, mode, bmdFormat8BitYUV)) format = bmdFormat8BitYUV;
    else return name + " can't output " + fourcc(mode);
    IDeckLinkDisplayMode* dm = nullptr;
    if (output->GetDisplayMode(mode, &dm) != S_OK || !dm) return name + ": no display mode " + fourcc(mode);
    width = (int)dm->GetWidth();
    height = (int)dm->GetHeight();
    dm->GetFrameRate(&duration, &scale);
    dm->Release();
    if (output->RowBytesForPixelFormat(format, width, &rowBytes) != S_OK) rowBytes = format == bmdFormat8BitBGRA ? width * 4 : width * 2;
    HRESULT r = output->EnableVideoOutput(mode, bmdVideoOutputFlagDefault);
    if (r != S_OK) return name + ": couldn't start its output (" + hresult(r) + "): is another app (Media Express, OBS, another copy of this app) using it?";
    enabled = true;
    for (int i = 0; i < POOL; i++) {
      Slot s;
      if (output->CreateVideoFrame(width, height, rowBytes, format, bmdFrameFlagDefault, &s.frame) != S_OK || !s.frame) return name + ": couldn't make video frames";
      fillBlack(s.frame);
      slots.push_back(s);
    }
    return "";
  }

  std::string start() {
    callback = new Callback(this);
    output->SetScheduledFrameCompletionCallback(callback);
    std::lock_guard<std::mutex> lock(mu);
    last = 0;
    for (int i = 0; i < PREROLL; i++) scheduleNext();
    HRESULT r = output->StartScheduledPlayback(0, scale, 1.0);
    if (r != S_OK) return name + ": couldn't start playback (" + hresult(r) + ")";
    playing = true;
    return "";
  }

  /** (Locked.) The next frame onto the timeline: the oldest waiting, or the last one again. */
  void scheduleNext() {
    if (!pending.empty()) {
      last = pending.front();
      pending.pop_front();
      slots[last].pending = false;
    } else if (playing)
      repeats++;
    Slot& s = slots[last];
    HRESULT r = output->ScheduleVideoFrame(s.frame, nextTime, duration, scale);
    if (r == S_OK) {
      s.scheduled++;
      scheduledCount++;
    } else
      scheduleErrors++;
    nextTime += duration;
  }

  /** (Locked.) Behind the device: on from just after where it is now. */
  void catchUp() {
    BMDTimeValue now = 0;
    double speed = 0;
    if (output->GetScheduledStreamTime(scale, &now, &speed) != S_OK) return;
    if (nextTime < now + duration) {
      nextTime = (now / duration + 2) * duration;
      catchUps++;
    }
  }

  void fillBlack(IDeckLinkMutableVideoFrame* f) {
    write(f, [&](uint8_t* p) {
      if (format == bmdFormat8BitBGRA) {
        for (int y = 0; y < height; y++) {
          uint8_t* row = p + (size_t)y * rowBytes;
          memset(row, 0, (size_t)width * 4);
          for (int x = 0; x < width; x++) row[x * 4 + 3] = 255;
        }
      } else
        for (int y = 0; y < height; y++) {
          uint8_t* row = p + (size_t)y * rowBytes;
          for (int x = 0; x < width * 2; x += 2) row[x] = 128, row[x + 1] = 16;
        }
    });
  }

  template <typename F>
  bool write(IDeckLinkMutableVideoFrame* f, F fill) {
    IDeckLinkVideoBuffer* buf = nullptr;
    if (f->QueryInterface(IID_IDeckLinkVideoBuffer, (void**)&buf) != S_OK || !buf) return false;
    bool ok = false;
    if (buf->StartAccess(bmdBufferAccessWrite) == S_OK) {
      void* p = nullptr;
      if (buf->GetBytes(&p) == S_OK && p) {
        fill((uint8_t*)p);
        ok = true;
      }
      buf->EndAccess(bmdBufferAccessWrite);
    }
    buf->Release();
    return ok;
  }

  Napi::Value Push(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!output || info.Length() < 1 || !info[0].IsBuffer()) return Napi::Boolean::New(env, false);
    Napi::Buffer<uint8_t> b = info[0].As<Napi::Buffer<uint8_t>>();
    if (b.Length() < (size_t)width * height * 4) {
      Napi::Error::New(env, "push: the frame is " + std::to_string(b.Length()) + " bytes, not " + std::to_string((size_t)width * height * 4) + " (" +
                                std::to_string(width) + "×" + std::to_string(height) + " BGRA)")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }
    int pick = -1;
    {
      std::lock_guard<std::mutex> lock(mu);
      for (int i = 0; i < (int)slots.size(); i++) {
        Slot& s = slots[i];
        if (i != last && !s.pending && !s.writing && s.scheduled == 0) {
          pick = i;
          break;
        }
      }
      if (pick < 0) {
        poolFull++;
        return Napi::Boolean::New(env, false);
      }
      slots[pick].writing = true;
    }
    const uint8_t* src = b.Data();
    write(slots[pick].frame, [&](uint8_t* p) {
      if (format == bmdFormat8BitBGRA) {
        if (rowBytes == width * 4) memcpy(p, src, (size_t)width * height * 4);
        else
          for (int y = 0; y < height; y++) memcpy(p + (size_t)y * rowBytes, src + (size_t)y * width * 4, (size_t)width * 4);
      } else
        bgraToUyvy(src, width * 4, p, rowBytes, width, height);
    });
    std::lock_guard<std::mutex> lock(mu);
    Slot& s = slots[pick];
    s.writing = false;
    s.pending = true;
    pending.push_back(pick);
    pushed++;
    while ((int)pending.size() > MAX_PENDING) {
      slots[pending.front()].pending = false;
      pending.pop_front();
      overflow++;
    }
    return Napi::Boolean::New(env, true);
  }

  Napi::Value Pending(const Napi::CallbackInfo& info) {
    std::lock_guard<std::mutex> lock(mu);
    return Napi::Number::New(info.Env(), (double)pending.size());
  }

  Napi::Value Stats(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Object o = Napi::Object::New(env);
    uint32_t buffered = 0;
    BMDReferenceStatus ref = 0;
    if (output) {
      output->GetBufferedVideoFrameCount(&buffered);
      output->GetReferenceStatus(&ref);
    }
    std::lock_guard<std::mutex> lock(mu);
    o.Set("name", name);
    o.Set("mode", fourcc(mode));
    o.Set("pixelFormat", format == bmdFormat8BitBGRA ? "bgra" : "yuv");
    o.Set("width", width);
    o.Set("height", height);
    o.Set("frameRate", scale && duration ? (double)scale / (double)duration : 0);
    o.Set("playing", playing);
    o.Set("buffered", buffered);
    o.Set("pending", (double)pending.size());
    o.Set("scheduled", (double)scheduledCount);
    o.Set("completed", (double)completedCount);
    o.Set("pushed", (double)pushed);
    o.Set("late", (double)late);
    o.Set("dropped", (double)dropped);
    o.Set("repeats", (double)repeats);
    o.Set("overflow", (double)overflow);
    o.Set("poolFull", (double)poolFull);
    o.Set("catchUps", (double)catchUps);
    o.Set("scheduleErrors", (double)scheduleErrors);
    o.Set("referenceLocked", (ref & bmdReferenceLocked) != 0);
    return o;
  }

  Napi::Value Close(const Napi::CallbackInfo& info) {
    closeDevice();
    return info.Env().Undefined();
  }

  void closeDevice() {
    {
      std::lock_guard<std::mutex> lock(mu);
      stopping = true;
    }
    if (callback) callback->player = nullptr;
    if (output) {
      if (playing) output->StopScheduledPlayback(0, nullptr, 0);
      output->SetScheduledFrameCompletionCallback(nullptr);
      if (enabled) output->DisableVideoOutput();
    }
    playing = false;
    enabled = false;
    for (Slot& s : slots)
      if (s.frame) s.frame->Release();
    slots.clear();
    pending.clear();
    if (callback) callback->Release();
    callback = nullptr;
    if (output) output->Release();
    output = nullptr;
    if (device) device->Release();
    device = nullptr;
    bool release;
    {
      std::lock_guard<std::mutex> lock(mu);
      release = hasTick;
      hasTick = false;
    }
    // (Abort: ticks still queued for the JS thread are dropped, not delivered after close.)
    if (release) tick.Abort();
  }

  IDeckLink* device = nullptr;
  IDeckLinkOutput* output = nullptr;
  Callback* callback = nullptr;
  std::string name;
  BMDDisplayMode mode = 0;
  BMDPixelFormat format = bmdFormat8BitBGRA;
  int width = 0, height = 0;
  int32_t rowBytes = 0;
  BMDTimeValue duration = 1001;
  BMDTimeScale scale = 60000;
  bool enabled = false, playing = false, stopping = false;

  std::mutex mu;
  std::vector<Slot> slots;
  std::deque<int> pending;
  int last = 0;
  BMDTimeValue nextTime = 0;
  uint64_t scheduledCount = 0, completedCount = 0, pushed = 0, late = 0, dropped = 0, repeats = 0, overflow = 0, poolFull = 0, catchUps = 0, scheduleErrors = 0;

  Napi::ThreadSafeFunction tick;
  bool hasTick = false;
};

HRESULT Callback::ScheduledFrameCompleted(IDeckLinkVideoFrame* frame, BMDOutputFrameCompletionResult result) {
  Player* p = player.load();
  if (p) p->completed(frame, result);
  return S_OK;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("list", Napi::Function::New(env, List));
  exports.Set("apiVersion", Napi::Function::New(env, ApiVersion));
  exports.Set("Player", Player::Init(env));
  return exports;
}

}  // namespace

NODE_API_MODULE(decklink, Init)
