// A stand-in for Desktop Video's libDeckLinkAPI.so (Linux), to test the addon and the app without a
// device: one "Fake UltraStudio" (or a card with several ports) with a video output that plays
// scheduled frames on its own clock, like the real thing. Build: test/build-fake.sh. Use:
// LD_LIBRARY_PATH=decklink/test/build.
//
//   FAKE_DECKLINK_FORMAT=bgra|yuv   the pixel format it takes (default bgra; yuv: it refuses BGRA)
//   FAKE_DECKLINK_PORTS=<n>         a card with n ports, each a device: "Fake DeckLink Duo 2 (1)"…
//   FAKE_DECKLINK_BUSY=1,3          those ports (numbered from 1) are in use by another app: they say
//                                   so (busy status), and won't start
//   FAKE_DECKLINK_HIDDEN_BUSY=2     those won't start either, but don't say they're busy
//   FAKE_DECKLINK_INACTIVE=4        those are inactive in the card's profile
//   FAKE_DECKLINK_STALL=<s>         it stops showing frames after that many seconds (unplugged)
//   FAKE_DECKLINK_LOG=<file>        each frame it shows, a line: its time slot, and the first 4
//                                   bytes of the picture as a number (or "late"/"dropped")

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <string>
#include <mutex>
#include <thread>
#include <vector>

#include "DeckLinkAPI.h"

namespace {

bool same(REFIID a, REFIID b) { return memcmp(&a, &b, sizeof(REFIID)) == 0; }
/** Whether port n (from 1) is in the comma-separated list in that environment variable. */
bool listed(const char* var, int n) {
  const char* v = getenv(var);
  if (!v) return false;
  std::string s = std::string(",") + v + ",";
  return s.find("," + std::to_string(n) + ",") != std::string::npos;
}
/** Ports this process is playing out of (they report busy, as Desktop Video's do, to everyone). */
std::atomic<unsigned> playing{0};
int ports() {
  const char* v = getenv("FAKE_DECKLINK_PORTS");
  int n = v ? atoi(v) : 1;
  return n < 1 ? 1 : n;
}
const char* dup(const char* s) { return strdup(s); }

template <typename T>
struct Ref : public T {
  std::atomic<ULONG> refs{1};
  ULONG STDMETHODCALLTYPE AddRef() override { return ++refs; }
  ULONG STDMETHODCALLTYPE Release() override {
    ULONG n = --refs;
    if (!n) delete this;
    return n;
  }
};

struct Buffer : Ref<IDeckLinkVideoBuffer> {
  std::vector<uint8_t> bytes;
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID, LPVOID* p) override { *p = nullptr; return E_NOINTERFACE; }
  HRESULT GetBytes(void** b) override { *b = bytes.data(); return S_OK; }
  HRESULT StartAccess(BMDBufferAccessFlags) override { return S_OK; }
  HRESULT EndAccess(BMDBufferAccessFlags) override { return S_OK; }
};

struct Frame : Ref<IDeckLinkMutableVideoFrame> {
  long w, h, row;
  BMDPixelFormat fmt;
  Buffer* buf;
  Frame(long w_, long h_, long r, BMDPixelFormat f) : w(w_), h(h_), row(r), fmt(f), buf(new Buffer) { buf->bytes.resize((size_t)r * h_); }
  ~Frame() { buf->Release(); }
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, LPVOID* p) override {
    if (same(iid, IID_IDeckLinkVideoBuffer)) { buf->AddRef(); *p = (IDeckLinkVideoBuffer*)buf; return S_OK; }
    *p = nullptr;
    return E_NOINTERFACE;
  }
  long GetWidth() override { return w; }
  long GetHeight() override { return h; }
  long GetRowBytes() override { return row; }
  BMDPixelFormat GetPixelFormat() override { return fmt; }
  BMDFrameFlags GetFlags() override { return 0; }
  HRESULT GetTimecode(BMDTimecodeFormat, IDeckLinkTimecode**) override { return E_NOTIMPL; }
  HRESULT GetAncillaryData(IDeckLinkVideoFrameAncillary**) override { return E_NOTIMPL; }
  HRESULT SetFlags(BMDFrameFlags) override { return S_OK; }
  HRESULT SetTimecode(BMDTimecodeFormat, IDeckLinkTimecode*) override { return E_NOTIMPL; }
  HRESULT SetTimecodeFromComponents(BMDTimecodeFormat, uint8_t, uint8_t, uint8_t, uint8_t, BMDTimecodeFlags) override { return E_NOTIMPL; }
  HRESULT SetAncillaryData(IDeckLinkVideoFrameAncillary*) override { return E_NOTIMPL; }
  HRESULT SetTimecodeUserBits(BMDTimecodeFormat, BMDTimecodeUserBits) override { return E_NOTIMPL; }
  HRESULT SetInterfaceProvider(REFIID, IUnknown*) override { return E_NOTIMPL; }
};

struct Mode : Ref<IDeckLinkDisplayMode> {
  BMDDisplayMode m;
  BMDTimeValue dur;
  BMDTimeScale scale;
  Mode(BMDDisplayMode m_, BMDTimeValue d, BMDTimeScale s) : m(m_), dur(d), scale(s) {}
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID, LPVOID* p) override { *p = nullptr; return E_NOINTERFACE; }
  HRESULT GetName(const char** n) override { *n = dup("fake"); return S_OK; }
  BMDDisplayMode GetDisplayMode() override { return m; }
  long GetWidth() override { return 1920; }
  long GetHeight() override { return 1080; }
  HRESULT GetFrameRate(BMDTimeValue* d, BMDTimeScale* s) override { *d = dur; *s = scale; return S_OK; }
  BMDFieldDominance GetFieldDominance() override { return 0; }
  BMDDisplayModeFlags GetFlags() override { return 0; }
};

bool rateOf(BMDDisplayMode m, BMDTimeValue* d, BMDTimeScale* s) {
  switch (m) {
    case bmdModeHD1080p5994: *d = 1001; *s = 60000; return true;
    case bmdModeHD1080p6000: *d = 1000; *s = 60000; return true;
    case bmdModeHD1080p50: *d = 1000; *s = 50000; return true;
    case bmdModeHD1080i5994: case bmdModeHD1080p2997: *d = 1001; *s = 30000; return true;
    case bmdModeHD1080i6000: case bmdModeHD1080p30: *d = 1000; *s = 30000; return true;
    case bmdModeHD1080i50: case bmdModeHD1080p25: *d = 1000; *s = 25000; return true;
    default: return false;
  }
}

struct Output : Ref<IDeckLinkOutput> {
  std::mutex mu;
  std::condition_variable cv;
  IDeckLinkVideoOutputCallback* cb = nullptr;
  BMDDisplayMode mode = 0;
  BMDTimeValue dur = 1001;
  BMDTimeScale scale = 60000;
  bool enabled = false, running = false, quit = false;
  std::multimap<BMDTimeValue, IDeckLinkVideoFrame*> queue;
  std::chrono::steady_clock::time_point started;
  BMDTimeValue startTime = 0;
  std::thread clock;
  FILE* log = nullptr;
  bool yuvOnly = false;
  int port = 1;

  explicit Output(int p) : port(p) {
    const char* f = getenv("FAKE_DECKLINK_FORMAT");
    yuvOnly = f && !strcmp(f, "yuv");
    const char* l = getenv("FAKE_DECKLINK_LOG");
    if (l) log = fopen(l, "w");
  }
  ~Output() {
    stopClock();
    if (log) fclose(log);
  }
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID, LPVOID* p) override { *p = nullptr; return E_NOINTERFACE; }

  BMDTimeValue nowLocked() {
    double s = std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count();
    return startTime + (BMDTimeValue)(s * scale);
  }

  void run() {
    std::unique_lock<std::mutex> lock(mu);
    BMDTimeValue slot = startTime;
    while (!quit) {
      auto due = started + std::chrono::duration<double>((double)(slot - startTime) / scale);
      cv.wait_until(lock, due, [&] { return quit; });
      if (quit) break;
      const char* stall = getenv("FAKE_DECKLINK_STALL");
      if (stall && (double)(slot - startTime) / scale > atof(stall)) {
        cv.wait(lock, [&] { return quit; });
        break;
      }
      // Everything due by this slot: the one for it is shown, any before it are dropped.
      std::vector<std::pair<IDeckLinkVideoFrame*, BMDOutputFrameCompletionResult>> done;
      while (!queue.empty() && queue.begin()->first <= slot) {
        auto it = queue.begin();
        bool onTime = it->first == slot;
        if (log) {
          uint32_t v = 0;
          IDeckLinkVideoBuffer* b = nullptr;
          if (it->second->QueryInterface(IID_IDeckLinkVideoBuffer, (void**)&b) == S_OK) {
            void* p;
            b->GetBytes(&p);
            memcpy(&v, p, 4);
            b->Release();
          }
          fprintf(log, "%lld %u %s\n", (long long)(it->first / dur), v, onTime ? "ok" : "dropped");
        }
        done.push_back({it->second, onTime ? bmdOutputFrameCompleted : bmdOutputFrameDropped});
        queue.erase(it);
      }
      if (done.empty() && log) fprintf(log, "%lld - empty\n", (long long)(slot / dur));
      IDeckLinkVideoOutputCallback* c = cb;
      lock.unlock();
      for (auto& d : done) {
        if (c) c->ScheduledFrameCompleted(d.first, d.second);
        d.first->Release();
      }
      lock.lock();
      slot += dur;
    }
  }

  void stopClock() {
    {
      std::lock_guard<std::mutex> l(mu);
      quit = true;
    }
    cv.notify_all();
    if (clock.joinable()) clock.join();
    std::vector<IDeckLinkVideoFrame*> left;
    {
      std::lock_guard<std::mutex> l(mu);
      for (auto& q : queue) left.push_back(q.second);
      queue.clear();
      running = false;
    }
    for (auto* f : left) {
      if (cb) cb->ScheduledFrameCompleted(f, bmdOutputFrameFlushed);
      f->Release();
    }
  }

  HRESULT DoesSupportVideoMode(BMDVideoConnection, BMDDisplayMode m, BMDPixelFormat f, BMDVideoOutputConversionMode, BMDSupportedVideoModeFlags, BMDDisplayMode* actual, bool* ok) override {
    BMDTimeValue d;
    BMDTimeScale s;
    *ok = rateOf(m, &d, &s) && (f == bmdFormat8BitYUV || (f == bmdFormat8BitBGRA && !yuvOnly));
    if (actual) *actual = m;
    return S_OK;
  }
  HRESULT GetDisplayMode(BMDDisplayMode m, IDeckLinkDisplayMode** out) override {
    BMDTimeValue d;
    BMDTimeScale s;
    if (!rateOf(m, &d, &s)) return E_FAIL;
    *out = new Mode(m, d, s);
    return S_OK;
  }
  HRESULT GetDisplayModeIterator(IDeckLinkDisplayModeIterator**) override { return E_NOTIMPL; }
  HRESULT SetScreenPreviewCallback(IDeckLinkScreenPreviewCallback*) override { return E_NOTIMPL; }
  HRESULT EnableVideoOutput(BMDDisplayMode m, BMDVideoOutputFlags) override {
    if (listed("FAKE_DECKLINK_BUSY", port) || listed("FAKE_DECKLINK_HIDDEN_BUSY", port)) return E_ACCESSDENIED;
    if (!rateOf(m, &dur, &scale)) return E_FAIL;
    mode = m;
    enabled = true;
    playing |= 1u << port;
    return S_OK;
  }
  HRESULT DisableVideoOutput() override {
    enabled = false;
    playing &= ~(1u << port);
    return S_OK;
  }
  HRESULT CreateVideoFrame(int32_t w, int32_t h, int32_t row, BMDPixelFormat f, BMDFrameFlags, IDeckLinkMutableVideoFrame** out) override {
    *out = new Frame(w, h, row, f);
    return S_OK;
  }
  HRESULT CreateVideoFrameWithBuffer(int32_t, int32_t, int32_t, BMDPixelFormat, BMDFrameFlags, IDeckLinkVideoBuffer*, IDeckLinkMutableVideoFrame**) override { return E_NOTIMPL; }
  HRESULT RowBytesForPixelFormat(BMDPixelFormat f, int32_t w, int32_t* row) override { *row = f == bmdFormat8BitBGRA ? w * 4 : w * 2; return S_OK; }
  HRESULT CreateAncillaryData(BMDPixelFormat, IDeckLinkVideoFrameAncillary**) override { return E_NOTIMPL; }
  HRESULT DisplayVideoFrameSync(IDeckLinkVideoFrame*) override { return E_NOTIMPL; }
  HRESULT ScheduleVideoFrame(IDeckLinkVideoFrame* f, BMDTimeValue t, BMDTimeValue, BMDTimeScale s) override {
    if (!enabled || s != scale) return E_FAIL;
    f->AddRef();
    std::lock_guard<std::mutex> l(mu);
    queue.insert({t, f});
    return S_OK;
  }
  HRESULT SetScheduledFrameCompletionCallback(IDeckLinkVideoOutputCallback* c) override {
    std::lock_guard<std::mutex> l(mu);
    cb = c;
    return S_OK;
  }
  HRESULT GetBufferedVideoFrameCount(uint32_t* n) override {
    std::lock_guard<std::mutex> l(mu);
    *n = (uint32_t)queue.size();
    return S_OK;
  }
  HRESULT EnableAudioOutput(BMDAudioSampleRate, BMDAudioSampleType, uint32_t, BMDAudioOutputStreamType) override { return E_NOTIMPL; }
  HRESULT DisableAudioOutput() override { return S_OK; }
  HRESULT WriteAudioSamplesSync(void*, uint32_t, uint32_t*) override { return E_NOTIMPL; }
  HRESULT BeginAudioPreroll() override { return E_NOTIMPL; }
  HRESULT EndAudioPreroll() override { return E_NOTIMPL; }
  HRESULT ScheduleAudioSamples(void*, uint32_t, BMDTimeValue, BMDTimeScale, uint32_t*) override { return E_NOTIMPL; }
  HRESULT GetBufferedAudioSampleFrameCount(uint32_t*) override { return E_NOTIMPL; }
  HRESULT FlushBufferedAudioSamples() override { return E_NOTIMPL; }
  HRESULT SetAudioCallback(IDeckLinkAudioOutputCallback*) override { return E_NOTIMPL; }
  HRESULT StartScheduledPlayback(BMDTimeValue t, BMDTimeScale s, double) override {
    if (!enabled || s != scale) return E_FAIL;
    std::lock_guard<std::mutex> l(mu);
    startTime = t;
    started = std::chrono::steady_clock::now();
    running = true;
    quit = false;
    clock = std::thread([this] { run(); });
    return S_OK;
  }
  HRESULT StopScheduledPlayback(BMDTimeValue, BMDTimeValue*, BMDTimeScale) override { stopClock(); return S_OK; }
  HRESULT IsScheduledPlaybackRunning(bool* a) override { *a = running; return S_OK; }
  HRESULT GetScheduledStreamTime(BMDTimeScale s, BMDTimeValue* t, double* speed) override {
    std::lock_guard<std::mutex> l(mu);
    if (!running) return E_FAIL;
    *t = nowLocked() * s / scale;
    *speed = 1;
    return S_OK;
  }
  HRESULT GetReferenceStatus(BMDReferenceStatus* r) override { *r = 0; return S_OK; }
  HRESULT GetHardwareReferenceClock(BMDTimeScale, BMDTimeValue*, BMDTimeValue*, BMDTimeValue*) override { return E_NOTIMPL; }
  HRESULT GetFrameCompletionReferenceTimestamp(IDeckLinkVideoFrame*, BMDTimeScale, BMDTimeValue*) override { return E_NOTIMPL; }
};

struct Status : Ref<IDeckLinkStatus> {
  int port;
  explicit Status(int p) : port(p) {}
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID, LPVOID* p) override { *p = nullptr; return E_NOINTERFACE; }
  HRESULT GetFlag(BMDDeckLinkStatusID, bool*) override { return E_NOTIMPL; }
  HRESULT GetInt(BMDDeckLinkStatusID id, int64_t* v) override {
    if (id != bmdDeckLinkStatusBusy) return E_NOTIMPL;
    *v = listed("FAKE_DECKLINK_BUSY", port) || (playing & (1u << port)) ? bmdDevicePlaybackBusy : 0;
    return S_OK;
  }
  HRESULT GetFloat(BMDDeckLinkStatusID, double*) override { return E_NOTIMPL; }
  HRESULT GetString(BMDDeckLinkStatusID, const char**) override { return E_NOTIMPL; }
  HRESULT GetBytes(BMDDeckLinkStatusID, void*, uint32_t*) override { return E_NOTIMPL; }
};

struct Attributes : Ref<IDeckLinkProfileAttributes> {
  int port;
  explicit Attributes(int p) : port(p) {}
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID, LPVOID* p) override { *p = nullptr; return E_NOINTERFACE; }
  HRESULT GetFlag(BMDDeckLinkAttributeID, bool*) override { return E_NOTIMPL; }
  HRESULT GetInt(BMDDeckLinkAttributeID id, int64_t* v) override {
    if (id == BMDDeckLinkDuplex) *v = listed("FAKE_DECKLINK_INACTIVE", port) ? bmdDuplexInactive : bmdDuplexHalf;
    else if (id == BMDDeckLinkPersistentID) *v = 0x1000 + port;
    else if (id == BMDDeckLinkSubDeviceIndex) *v = port - 1;
    else return E_NOTIMPL;
    return S_OK;
  }
  HRESULT GetFloat(BMDDeckLinkAttributeID, double*) override { return E_NOTIMPL; }
  HRESULT GetString(BMDDeckLinkAttributeID, const char**) override { return E_NOTIMPL; }
};

struct Device : Ref<IDeckLink> {
  int port;
  explicit Device(int p) : port(p) {}
  std::string name() const { return ports() == 1 ? "Fake UltraStudio Monitor 3G" : "Fake DeckLink Duo 2 (" + std::to_string(port) + ")"; }
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, LPVOID* p) override {
    if (same(iid, IID_IDeckLinkOutput)) { *p = (IDeckLinkOutput*)new Output(port); return S_OK; }
    if (same(iid, IID_IDeckLinkStatus)) { *p = (IDeckLinkStatus*)new Status(port); return S_OK; }
    if (same(iid, IID_IDeckLinkProfileAttributes)) { *p = (IDeckLinkProfileAttributes*)new Attributes(port); return S_OK; }
    *p = nullptr;
    return E_NOINTERFACE;
  }
  HRESULT GetModelName(const char** n) override { *n = dup(ports() == 1 ? "Fake UltraStudio Monitor 3G" : "Fake DeckLink Duo 2"); return S_OK; }
  HRESULT GetDisplayName(const char** n) override { *n = dup(name().c_str()); return S_OK; }
};

struct Iterator : Ref<IDeckLinkIterator> {
  int n = 0;
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID, LPVOID* p) override { *p = nullptr; return E_NOINTERFACE; }
  HRESULT Next(IDeckLink** d) override {
    if (n >= ports()) return S_FALSE;
    *d = new Device(++n);
    return S_OK;
  }
};

struct Info : Ref<IDeckLinkAPIInformation> {
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID, LPVOID* p) override { *p = nullptr; return E_NOINTERFACE; }
  HRESULT GetFlag(BMDDeckLinkAPIInformationID, bool*) override { return E_NOTIMPL; }
  HRESULT GetInt(BMDDeckLinkAPIInformationID, int64_t*) override { return E_NOTIMPL; }
  HRESULT GetFloat(BMDDeckLinkAPIInformationID, double*) override { return E_NOTIMPL; }
  HRESULT GetString(BMDDeckLinkAPIInformationID, const char** v) override { *v = dup("14.4 (fake)"); return S_OK; }
};

}  // namespace

extern "C" {
__attribute__((visibility("default"))) IDeckLinkIterator* CreateDeckLinkIteratorInstance_0004() { return new Iterator; }
__attribute__((visibility("default"))) IDeckLinkAPIInformation* CreateDeckLinkAPIInformationInstance_0001() { return new Info; }
// (Looked up by the SDK's dispatch code; not used.)
__attribute__((visibility("default"))) void* CreateVideoConversionInstance_0002() { return nullptr; }
__attribute__((visibility("default"))) void* CreateDeckLinkDiscoveryInstance_0003() { return nullptr; }
__attribute__((visibility("default"))) void* CreateVideoFrameAncillaryPacketsInstance_0001() { return nullptr; }
}
