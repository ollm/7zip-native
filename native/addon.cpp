#include <napi.h>

#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <cmath>
#include <codecvt>
#include <condition_variable>
#include <cstdint>
#include <cstring>
#include <cstdio>
#include <cstdlib>
#include <cwctype>
#include <deque>
#include <filesystem>
#include <fstream>
#include <limits>
#include <locale>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

#ifndef _WIN32
#include <dlfcn.h>
#include <cerrno>
#include <fcntl.h>
#include <unistd.h>
#else
#include <fcntl.h>
#include <io.h>
#include <sys/stat.h>
#endif

#include "Common/MyInitGuid.h"
#include "Common/MyCom.h"
#include "Common/StringConvert.h"
#include "7zip/Archive/IArchive.h"
#include "7zip/IPassword.h"
#include "Windows/PropVariant.h"

namespace {

constexpr std::uint64_t kMaxPendingOperations = 128;
constexpr std::uint32_t kMaxExtractionConcurrency = 128;
constexpr std::uint64_t kMaxEntries = 1'000'000;
constexpr std::uint64_t kMaxSingleOutputBytes = 256ULL * 1024 * 1024;
constexpr std::uint64_t kMaxNestedTarBytes = 1024ULL * 1024 * 1024;
constexpr std::uint64_t kMaxConcurrentOutputBytes = 512ULL * 1024 * 1024;
constexpr std::uint64_t kMaxReadBytes = 64ULL * 1024 * 1024;
constexpr std::size_t kMaxPasswordBytes = 1024 * 1024;
constexpr std::uint32_t kMinDeflateBufferSize = 4 * 1024;
constexpr std::uint32_t kMaxDeflateBufferSize = 2 * 1024 * 1024;

using CreateObjectFunction = HRESULT (STDAPICALLTYPE *)(const GUID *, const GUID *, void **);
using GetHandlerPropertyFunction = HRESULT (STDAPICALLTYPE *)(UInt32, PROPID, PROPVARIANT *);
using GetNumberOfFormatsFunction = HRESULT (STDAPICALLTYPE *)(UInt32 *);
using GetIsArcFunction = HRESULT (STDAPICALLTYPE *)(UInt32, Func_IsArc *);
using SetDeflateInputBufferSizeFunction = HRESULT (STDAPICALLTYPE *)(UInt32);

std::wstring FromUtf8(const std::string& value);

#ifdef _WIN32
using EngineModule = HMODULE;
#else
using EngineModule = void *;
#endif

std::atomic<std::uint64_t> g_pendingOperations{0};
std::atomic<std::uint32_t> g_extractionConcurrency{1};
std::atomic<std::uint64_t> g_nextHandle{1};
std::atomic<std::uint64_t> g_nextStreamId{1};
std::atomic<std::uint64_t> g_nextFileTaskId{1};
std::mutex g_handlesMutex;
std::unordered_map<std::uint64_t, std::shared_ptr<class ArchiveEngine>> g_handles;
std::mutex g_streamsMutex;
std::unordered_map<std::uint64_t, std::shared_ptr<class NativeStreamState>> g_streams;
std::mutex g_fileTasksMutex;
std::unordered_map<std::uint64_t, std::shared_ptr<class NativeFileTaskState>> g_fileTasks;
std::mutex g_outputBudgetMutex;
std::condition_variable g_outputBudgetAvailable;
std::uint64_t g_reservedOutputBytes = 0;
std::mutex g_engineMutex;
EngineModule g_engineModule = nullptr;
std::string g_enginePath;
CreateObjectFunction g_createObject = nullptr;
GetHandlerPropertyFunction g_getHandlerProperty = nullptr;
GetNumberOfFormatsFunction g_getNumberOfFormats = nullptr;
GetIsArcFunction g_getIsArc = nullptr;
SetDeflateInputBufferSizeFunction g_setDeflateInputBufferSize = nullptr;
class ExtractionPool;
ExtractionPool *g_extractionPool = nullptr;

template<typename Function>
Function LoadEngineFunction(const char *name)
{
#ifdef _WIN32
	return reinterpret_cast<Function>(::GetProcAddress(g_engineModule, name));
#else
	return reinterpret_cast<Function>(::dlsym(g_engineModule, name));
#endif
}

std::uint64_t RegisterStream(std::shared_ptr<class NativeStreamState> stream);
std::shared_ptr<class NativeStreamState> FindStream(std::uint64_t streamId);
void RemoveStream(std::uint64_t streamId);
std::uint64_t RegisterFileTask(std::shared_ptr<class NativeFileTaskState> task);
std::shared_ptr<class NativeFileTaskState> FindFileTask(std::uint64_t taskId);
void RemoveFileTask(std::uint64_t taskId);

void EnsureEngineLoaded(const std::string& path)
{
	std::lock_guard<std::mutex> lock(g_engineMutex);
	if (g_engineModule != nullptr) {
		if (g_enginePath != path) {
			throw std::runtime_error("Only one 7-Zip engine path can be loaded per process");
		}
		return;
	}
#ifdef _WIN32
	const auto widePath = FromUtf8(path);
	g_engineModule = ::LoadLibraryW(widePath.c_str());
	if (g_engineModule == nullptr) {
		throw std::runtime_error("Unable to load the bundled 7-Zip engine DLL");
	}
#else
	g_engineModule = ::dlopen(path.c_str(), RTLD_NOW | RTLD_LOCAL);
	if (g_engineModule == nullptr) {
		const auto *error = ::dlerror();
		throw std::runtime_error(
			std::string("Unable to load the bundled 7-Zip engine: ")
			+ (error == nullptr ? "unknown loader error" : error));
	}
#endif
	g_createObject = LoadEngineFunction<CreateObjectFunction>("CreateObject");
	g_getHandlerProperty = LoadEngineFunction<GetHandlerPropertyFunction>("GetHandlerProperty2");
	g_getNumberOfFormats = LoadEngineFunction<GetNumberOfFormatsFunction>("GetNumberOfFormats");
	g_getIsArc = LoadEngineFunction<GetIsArcFunction>("GetIsArc");
	g_setDeflateInputBufferSize =
		LoadEngineFunction<SetDeflateInputBufferSizeFunction>("SetDeflateInputBufferSize");
	if (g_createObject == nullptr || g_getHandlerProperty == nullptr
		|| g_getNumberOfFormats == nullptr || g_getIsArc == nullptr
		|| g_setDeflateInputBufferSize == nullptr) {
#ifdef _WIN32
		::FreeLibrary(g_engineModule);
#else
		::dlclose(g_engineModule);
#endif
		g_engineModule = nullptr;
		g_createObject = nullptr;
		g_getHandlerProperty = nullptr;
		g_getNumberOfFormats = nullptr;
		g_getIsArc = nullptr;
		g_setDeflateInputBufferSize = nullptr;
		throw std::runtime_error("The bundled 7-Zip engine is missing required exports");
	}
	g_enginePath = path;
}

bool ReserveOperation()
{
	auto pending = g_pendingOperations.load(std::memory_order_relaxed);
	while (pending < kMaxPendingOperations) {
		if (g_pendingOperations.compare_exchange_weak(
			pending, pending + 1, std::memory_order_acq_rel, std::memory_order_relaxed)) {
			return true;
		}
	}
	return false;
}

std::wstring FromUtf8(const std::string& value)
{
#ifdef _WIN32
	std::wstring_convert<std::codecvt_utf8_utf16<wchar_t>> converter;
#else
	std::wstring_convert<std::codecvt_utf8<wchar_t>> converter;
#endif
	return converter.from_bytes(value);
}

template<typename Character>
void SecureErase(std::basic_string<Character>& value) noexcept
{
	volatile Character *characters = value.empty() ? nullptr : value.data();
	for (std::size_t i = 0; i < value.size(); ++i) {
		characters[i] = Character{};
	}
	value.clear();
}

std::filesystem::path NativePath(const std::string& path)
{
#ifdef _WIN32
	return std::filesystem::path(FromUtf8(path));
#else
	return std::filesystem::path(path);
#endif
}

struct FileStamp {
	std::uintmax_t size;
	std::filesystem::file_time_type modified;
};

struct StreamMessage {
	enum class Kind {
		Chunk,
		End,
		Error
	};

	Kind kind;
	std::vector<std::uint8_t> data;
	std::string error;
};

void StreamMessageToJs(Napi::Env env, Napi::Function callback, StreamMessage *message);
class FileCompletionAcknowledgement {
public:
	void Acknowledge()
	{
		{
			std::lock_guard<std::mutex> lock(mutex_);
			acknowledged_ = true;
		}
		completed_.notify_one();
	}

	void Wait()
	{
		std::unique_lock<std::mutex> lock(mutex_);
		completed_.wait(lock, [this] { return acknowledged_; });
	}

private:
	std::mutex mutex_;
	std::condition_variable completed_;
	bool acknowledged_ = false;
};

struct FileCompletionMessage {
	enum class Kind {
		File,
		Barrier,
	};

	Kind kind;
	std::uint32_t entryId;
	std::shared_ptr<FileCompletionAcknowledgement> acknowledgement;
};
void FileCompletionToJs(Napi::Env env, Napi::Function callback, FileCompletionMessage *message);

class NativeStreamState {
public:
	void Resume()
	{
		{
			std::lock_guard<std::mutex> lock(mutex_);
			if (!cancelled_) {
				demand_ = true;
			}
		}
		available_.notify_one();
	}

	void Cancel()
	{
		{
			std::lock_guard<std::mutex> lock(mutex_);
			cancelled_ = true;
		}
		available_.notify_all();
	}

	bool IsCancelled() const
	{
		std::lock_guard<std::mutex> lock(mutex_);
		return cancelled_;
	}

	bool WaitForDemand()
	{
		std::unique_lock<std::mutex> lock(mutex_);
		available_.wait(lock, [this]() { return cancelled_ || demand_; });
		if (cancelled_) {
			return false;
		}
		demand_ = false;
		return true;
	}

	bool Send(std::unique_ptr<StreamMessage> message)
	{
		const auto status = callback.BlockingCall(message.get(), StreamMessageToJs);
		if (status != napi_ok) {
			Cancel();
			return false;
		}
		message.release();
		return true;
	}

	void ReleaseCallback()
	{
		if (!callbackReleased_.exchange(true, std::memory_order_acq_rel)) {
			callback.Release();
		}
	}

	std::uint64_t id = 0;
	Napi::ThreadSafeFunction callback;

private:
	mutable std::mutex mutex_;
	std::condition_variable available_;
	bool cancelled_ = false;
	bool demand_ = false;
	std::atomic<bool> callbackReleased_{false};
};

class NativeFileTaskState {
public:
	void Cancel()
	{
		cancelled_.store(true, std::memory_order_release);
	}

	bool IsCancelled() const
	{
		return cancelled_.load(std::memory_order_acquire);
	}

	void Fail(std::string error)
	{
		{
			std::lock_guard<std::mutex> lock(failureMutex_);
			if (failure_.empty()) {
				failure_ = std::move(error);
			}
		}
		Cancel();
	}

	std::string Failure() const
	{
		std::lock_guard<std::mutex> lock(failureMutex_);
		return failure_;
	}

	bool ReportFileCompleted(std::uint32_t entryId)
	{
		if (!hasFileCompletionCallback_) {
			return !IsCancelled();
		}
		auto *message = new FileCompletionMessage{
			FileCompletionMessage::Kind::File,
			entryId,
			{},
		};
		const auto status = fileCompletionCallback.BlockingCall(message, FileCompletionToJs);
		if (status != napi_ok) {
			delete message;
			Cancel();
			return false;
		}
		return !IsCancelled();
	}

	bool WaitForFileCompletions()
	{
		if (!hasFileCompletionCallback_) {
			return true;
		}
		auto acknowledgement = std::make_shared<FileCompletionAcknowledgement>();
		auto *message = new FileCompletionMessage{
			FileCompletionMessage::Kind::Barrier,
			0,
			acknowledgement,
		};
		const auto status = fileCompletionCallback.BlockingCall(message, FileCompletionToJs);
		if (status != napi_ok) {
			delete message;
			Cancel();
			return false;
		}
		acknowledgement->Wait();
		return true;
	}

	void ReleaseCallback()
	{
		if (hasFileCompletionCallback_
			&& !fileCompletionCallbackReleased_.exchange(true, std::memory_order_acq_rel)) {
			fileCompletionCallback.Release();
		}
	}
	std::uint64_t id = 0;
	Napi::ThreadSafeFunction fileCompletionCallback;
	bool hasFileCompletionCallback_ = false;

private:
	std::atomic<bool> cancelled_{false};
	std::atomic<bool> fileCompletionCallbackReleased_{false};
	mutable std::mutex failureMutex_;
	std::string failure_;
};

std::uint64_t RegisterStream(std::shared_ptr<NativeStreamState> stream)
{
	const auto streamId = g_nextStreamId.fetch_add(1, std::memory_order_relaxed);
	if (streamId == 0) {
		throw std::overflow_error("Native stream handle space exhausted");
	}
	std::lock_guard<std::mutex> lock(g_streamsMutex);
	stream->id = streamId;
	g_streams.emplace(streamId, std::move(stream));
	return streamId;
}

std::shared_ptr<NativeStreamState> FindStream(std::uint64_t streamId)
{
	std::lock_guard<std::mutex> lock(g_streamsMutex);
	const auto found = g_streams.find(streamId);
	return found == g_streams.end() ? nullptr : found->second;
}

void RemoveStream(std::uint64_t streamId)
{
	std::lock_guard<std::mutex> lock(g_streamsMutex);
	g_streams.erase(streamId);
}

std::uint64_t RegisterFileTask(std::shared_ptr<NativeFileTaskState> task)
{
	const auto taskId = g_nextFileTaskId.fetch_add(1, std::memory_order_relaxed);
	if (taskId == 0) {
		throw std::overflow_error("Native file task handle space exhausted");
	}
	std::lock_guard<std::mutex> lock(g_fileTasksMutex);
	task->id = taskId;
	g_fileTasks.emplace(taskId, std::move(task));
	return taskId;
}

std::shared_ptr<NativeFileTaskState> FindFileTask(std::uint64_t taskId)
{
	std::lock_guard<std::mutex> lock(g_fileTasksMutex);
	const auto found = g_fileTasks.find(taskId);
	return found == g_fileTasks.end() ? nullptr : found->second;
}

void RemoveFileTask(std::uint64_t taskId)
{
	std::lock_guard<std::mutex> lock(g_fileTasksMutex);
	g_fileTasks.erase(taskId);
}

FileStamp GetFileStamp(const std::string& path)
{
	std::error_code error;
	const auto size = std::filesystem::file_size(NativePath(path), error);
	if (error) {
		throw std::runtime_error("Unable to read archive file size");
	}
	const auto modified = std::filesystem::last_write_time(NativePath(path), error);
	if (error) {
		throw std::runtime_error("Unable to read archive modification time");
	}
	return {size, modified};
}

class OutputReservation {
public:
	~OutputReservation()
	{
		if (reserved_ == 0) {
			return;
		}
		{
			std::lock_guard<std::mutex> lock(g_outputBudgetMutex);
			g_reservedOutputBytes -= reserved_;
		}
		g_outputBudgetAvailable.notify_all();
	}

	void Acquire(std::uint64_t bytes)
	{
		if (bytes > kMaxConcurrentOutputBytes) {
			throw std::length_error("Requested output exceeds the concurrent memory limit");
		}
		if (bytes == 0) {
			return;
		}
		std::unique_lock<std::mutex> lock(g_outputBudgetMutex);
		g_outputBudgetAvailable.wait(lock, [bytes]() {
			return bytes <= kMaxConcurrentOutputBytes - g_reservedOutputBytes;
		});
		g_reservedOutputBytes += bytes;
		reserved_ = bytes;
	}

private:
	std::uint64_t reserved_ = 0;
};

HRESULT GetPasswordBstr(const std::optional<std::string>& password, BSTR *result)
{
	if (result == nullptr) {
		return E_INVALIDARG;
	}
	*result = nullptr;
	if (!password) {
		return E_ABORT;
	}
	std::wstring widePassword;
	try {
		widePassword = FromUtf8(*password);
	} catch (...) {
		return E_INVALIDARG;
	}
	struct WipeOnExit {
		std::wstring& value;
		~WipeOnExit() { SecureErase(value); }
	} wipe{widePassword};
	if (widePassword.size() > std::numeric_limits<UINT>::max()) {
		return E_INVALIDARG;
	}
	*result = ::SysAllocStringLen(
		widePassword.data(),
		static_cast<UINT>(widePassword.size()));
	return *result == nullptr ? E_OUTOFMEMORY : S_OK;
}

std::string ToUtf8(const wchar_t *value)
{
	if (value == nullptr) {
		return {};
	}
#ifdef _WIN32
	std::wstring_convert<std::codecvt_utf8_utf16<wchar_t>> converter;
#else
	std::wstring_convert<std::codecvt_utf8<wchar_t>> converter;
#endif
	return converter.to_bytes(value);
}

std::string LowerAscii(std::string value)
{
	std::transform(value.begin(), value.end(), value.begin(), [](unsigned char ch) {
		return static_cast<char>(std::tolower(ch));
	});
	return value;
}

std::string Extension(const std::string& path)
{
	const auto separator = path.find_last_of("/\\");
	const auto dot = path.find_last_of('.');
	if (dot == std::string::npos || (separator != std::string::npos && dot < separator)) {
		return {};
	}
	return LowerAscii(path.substr(dot + 1));
}

bool IsCompressedTarPath(const std::string& path)
{
	const auto lowerPath = LowerAscii(path);
	for (const std::string suffix : {
		".tar.gz", ".tar.bz2", ".tar.bzip2", ".tar.xz", ".tar.zst", ".tar.zstd"
	}) {
		if (lowerPath.size() >= suffix.size()
			&& lowerPath.compare(lowerPath.size() - suffix.size(), suffix.size(), suffix) == 0) {
			return true;
		}
	}
	return false;
}

bool HasTarHeader(const std::vector<std::uint8_t>& data)
{
	if (data.size() < 512) {
		return false;
	}
	std::size_t start = 148;
	std::size_t end = 156;
	while (start < end && (data[start] == 0 || data[start] == ' ')) {
		++start;
	}
	while (end > start && (data[end - 1] == 0 || data[end - 1] == ' ')) {
		--end;
	}
	if (start == end) {
		return false;
	}
	std::uint64_t expected = 0;
	for (std::size_t index = start; index < end; ++index) {
		if (data[index] < '0' || data[index] > '7') {
			return false;
		}
		expected = expected * 8 + (data[index] - '0');
	}
	std::uint64_t actual = 0;
	for (std::size_t index = 0; index < 512; ++index) {
		actual += index >= 148 && index < 156 ? ' ' : data[index];
	}
	return expected == actual;
}

std::vector<std::string> SplitExtensions(const std::wstring& value)
{
	std::wstring normalized = value;
	for (auto& ch : normalized) {
		if (ch == L';' || ch == L',' || ch == L'*' || ch == L'.') {
			ch = L' ';
		}
	}
	std::vector<std::string> result;
	std::wstring token;
	for (const auto ch : normalized) {
		if (std::iswspace(ch)) {
			if (!token.empty()) {
				result.push_back(LowerAscii(ToUtf8(token.c_str())));
				token.clear();
			}
		} else {
			token.push_back(ch);
		}
	}
	if (!token.empty()) {
		result.push_back(LowerAscii(ToUtf8(token.c_str())));
	}
	return result;
}

bool ReadUnsigned(const Napi::Value& value, std::uint64_t& result)
{
	if (value.IsBigInt()) {
		bool lossless = false;
		result = value.As<Napi::BigInt>().Uint64Value(&lossless);
		return lossless;
	}
	if (!value.IsNumber()) {
		return false;
	}
	const double number = value.As<Napi::Number>().DoubleValue();
	if (!std::isfinite(number) || number < 0 || std::floor(number) != number
		|| number > 9007199254740991.0) {
		return false;
	}
	result = static_cast<std::uint64_t>(number);
	return true;
}

std::uint64_t GetHandle(const Napi::Value& value)
{
	std::uint64_t handle = 0;
	if (!ReadUnsigned(value, handle) || handle == 0) {
		throw Napi::TypeError::New(value.Env(), "Invalid archive handle");
	}
	return handle;
}

std::shared_ptr<class ArchiveEngine> FindArchive(std::uint64_t handle)
{
	std::lock_guard<std::mutex> lock(g_handlesMutex);
	const auto found = g_handles.find(handle);
	if (found == g_handles.end()) {
		return {};
	}
	return found->second;
}

std::uint64_t RegisterArchive(std::shared_ptr<class ArchiveEngine> archive)
{
	const auto handle = g_nextHandle.fetch_add(1, std::memory_order_relaxed);
	if (handle == 0) {
		throw std::runtime_error("Archive handle space exhausted");
	}
	std::lock_guard<std::mutex> lock(g_handlesMutex);
	g_handles.emplace(handle, std::move(archive));
	return handle;
}

struct Entry {
	std::uint32_t id = 0;
	std::string path;
	std::uint64_t size = 0;
	std::uint64_t compressedSize = 0;
	std::uint32_t attributes = 0;
	std::uint32_t crc = 0;
	bool hasCrc = false;
	bool directory = false;
	bool encrypted = false;
};

struct ArchiveCreateItem {
	std::string sourcePath;
	std::string path;
	double mtimeMs = 0;
};

FILETIME UnixMillisecondsToFileTime(double milliseconds)
{
	constexpr long double windowsEpochOffsetMs = 11644473600000.0L;
	constexpr long double ticksPerMillisecond = 10000.0L;
	const long double ticks =
		(static_cast<long double>(milliseconds) + windowsEpochOffsetMs) * ticksPerMillisecond;
	if (!std::isfinite(milliseconds) || ticks < 0
		|| ticks > static_cast<long double>(std::numeric_limits<UInt64>::max())) {
		throw std::out_of_range("Source file modification time is outside the FILETIME range");
	}
	const auto value = static_cast<UInt64>(ticks);
	FILETIME fileTime{};
	fileTime.dwLowDateTime = static_cast<DWORD>(value);
	fileTime.dwHighDateTime = static_cast<DWORD>(value >> 32);
	return fileTime;
}

std::uint64_t GetPropUInt64(IInArchive *archive, std::uint32_t index, PROPID propId)
{
	NWindows::NCOM::CPropVariant value;
	if (archive->GetProperty(index, propId, &value) != S_OK) {
		return 0;
	}
	if (value.vt == VT_UI8) {
		return value.uhVal.QuadPart;
	}
	if (value.vt == VT_UI4) {
		return value.ulVal;
	}
	if (value.vt == VT_I8 && value.hVal.QuadPart >= 0) {
		return static_cast<std::uint64_t>(value.hVal.QuadPart);
	}
	if (value.vt == VT_I4 && value.lVal >= 0) {
		return static_cast<std::uint64_t>(value.lVal);
	}
	return 0;
}

bool GetPropBool(IInArchive *archive, std::uint32_t index, PROPID propId)
{
	NWindows::NCOM::CPropVariant value;
	if (archive->GetProperty(index, propId, &value) != S_OK || value.vt != VT_BOOL) {
		return false;
	}
	return value.boolVal != VARIANT_FALSE;
}

bool IsSolidArchive(IInArchive *archive)
{
	NWindows::NCOM::CPropVariant value;
	return archive->GetArchiveProperty(kpidSolid, &value) == S_OK
		&& value.vt == VT_BOOL
		&& value.boolVal != VARIANT_FALSE;
}

std::string GetPropString(IInArchive *archive, std::uint32_t index, PROPID propId)
{
	NWindows::NCOM::CPropVariant value;
	if (archive->GetProperty(index, propId, &value) != S_OK || value.vt != VT_BSTR) {
		return {};
	}
	return ToUtf8(value.bstrVal);
}

struct OutputRequest {
	std::uint32_t id = 0;
	std::uint64_t offset = 0;
	std::uint64_t length = 0;
	std::uint64_t entrySize = 0;
	std::uint64_t maxOutputBytes = kMaxSingleOutputBytes;
	bool encrypted = false;
	bool abortOnLimit = false;
	bool limitReached = false;
	std::vector<std::uint8_t> data;
	std::int32_t operationResult = NArchive::NExtract::NOperationResult::kUnavailable;
};

struct ReadRange {
	std::uint64_t offset;
	std::uint64_t length;
};

struct ExtractionProfile {
	double validationMs = 0;
	double reservationMs = 0;
	double requestSetupMs = 0;
	double contextAcquireMs = 0;
	double solidCheckMs = 0;
	double callbackSetupMs = 0;
	double sevenZipExtractMs = 0;
	double resultProcessingMs = 0;
	double minSevenZipCallMs = 0;
	double maxSevenZipCallMs = 0;
	std::uint32_t sevenZipCalls = 0;
	bool abortPerItem = false;
};

class FileInStream final : public IInStream, public CMyUnknownImp {
	Z7_COM_QI_BEGIN2(IInStream)
	Z7_COM_QI_ENTRY(ISequentialInStream)
	Z7_COM_QI_END
	Z7_COM_ADDREF_RELEASE

	Z7_IFACE_COM7_IMP(ISequentialInStream)
	Z7_IFACE_COM7_IMP(IInStream)

public:
	bool Open(const std::string& path)
	{
		file_.open(NativePath(path), std::ios::binary);
		if (!file_.is_open()) {
			return false;
		}
		file_.seekg(0, std::ios::end);
		const auto end = file_.tellg();
		if (end < 0 || static_cast<std::uint64_t>(end) > static_cast<std::uint64_t>(INT64_MAX)) {
			file_.close();
			return false;
		}
		length_ = static_cast<std::uint64_t>(end);
		file_.clear();
		file_.seekg(0, std::ios::beg);
		return file_.good();
	}

private:
	std::mutex mutex_;
	std::ifstream file_;
	std::uint64_t length_ = 0;
};

Z7_COM7F_IMF(FileInStream::Read(void *data, UInt32 size, UInt32 *processedSize))
{
	std::lock_guard<std::mutex> lock(mutex_);
	file_.clear();
	file_.read(static_cast<char *>(data), static_cast<std::streamsize>(size));
	const auto count = file_.gcount();
	if (processedSize != nullptr) {
		*processedSize = static_cast<UInt32>(count);
	}
	if (file_.bad()) {
		return E_FAIL;
	}
	return S_OK;
}

Z7_COM7F_IMF(FileInStream::Seek(Int64 offset, UInt32 seekOrigin, UInt64 *newPosition))
{
	std::lock_guard<std::mutex> lock(mutex_);
	std::uint64_t base = 0;
	switch (seekOrigin) {
		case 0:
			break;
		case 1: {
			file_.clear();
			const auto current = file_.tellg();
			if (current < 0) {
				return E_FAIL;
			}
			base = static_cast<std::uint64_t>(current);
			break;
		}
		case 2:
			base = length_;
			break;
		default:
			return E_INVALIDARG;
	}
	std::uint64_t target = 0;
	if (offset >= 0) {
		const auto advance = static_cast<std::uint64_t>(offset);
		if (advance > static_cast<std::uint64_t>(INT64_MAX) - base) {
			return E_INVALIDARG;
		}
		target = base + advance;
	} else {
		const auto retreat = static_cast<std::uint64_t>(-(offset + 1)) + 1;
		if (retreat > base) {
			return E_INVALIDARG;
		}
		target = base - retreat;
	}
	file_.clear();
	file_.seekg(static_cast<std::streamoff>(target), std::ios::beg);
	if (!file_.good()) {
		return E_FAIL;
	}
	if (newPosition != nullptr) {
		*newPosition = target;
	}
	return S_OK;
}

class MemoryInStream final : public IInStream, public CMyUnknownImp {
	Z7_COM_QI_BEGIN2(IInStream)
	Z7_COM_QI_ENTRY(ISequentialInStream)
	Z7_COM_QI_END
	Z7_COM_ADDREF_RELEASE

	Z7_IFACE_COM7_IMP(ISequentialInStream)
	Z7_IFACE_COM7_IMP(IInStream)

public:
	explicit MemoryInStream(const std::vector<std::uint8_t>& data): data_(data) {}

private:
	const std::vector<std::uint8_t>& data_;
	std::mutex mutex_;
	std::uint64_t position_ = 0;
};

Z7_COM7F_IMF(MemoryInStream::Read(void *data, UInt32 size, UInt32 *processedSize))
{
	std::lock_guard<std::mutex> lock(mutex_);
	const auto available = position_ < data_.size() ? data_.size() - position_ : 0;
	const auto count = static_cast<UInt32>(std::min<std::uint64_t>(
		size, available));
	if (count != 0) {
		std::memcpy(data, data_.data() + position_, count);
		position_ += count;
	}
	if (processedSize != nullptr) {
		*processedSize = count;
	}
	return S_OK;
}

Z7_COM7F_IMF(MemoryInStream::Seek(Int64 offset, UInt32 seekOrigin, UInt64 *newPosition))
{
	std::lock_guard<std::mutex> lock(mutex_);
	std::uint64_t base = 0;
	switch (seekOrigin) {
		case 0:
			break;
		case 1:
			base = position_;
			break;
		case 2:
			base = data_.size();
			break;
		default:
			return E_INVALIDARG;
	}
	std::uint64_t target = 0;
	if (offset >= 0) {
		const auto advance = static_cast<std::uint64_t>(offset);
		if (advance > static_cast<std::uint64_t>(INT64_MAX) - base) {
			return E_INVALIDARG;
		}
		target = base + advance;
	} else {
		const auto retreat = static_cast<std::uint64_t>(-(offset + 1)) + 1;
		if (retreat > base) {
			return E_INVALIDARG;
		}
		target = base - retreat;
	}
	position_ = target;
	if (newPosition != nullptr) {
		*newPosition = target;
	}
	return S_OK;
}

class CreateFileInStream final : public ISequentialInStream, public CMyUnknownImp {
	Z7_COM_UNKNOWN_IMP_1(ISequentialInStream)
	Z7_COM7F_IMP(Read(void *data, UInt32 size, UInt32 *processedSize))

public:
	bool Open(const std::string& path)
	{
		file_.open(NativePath(path), std::ios::binary);
		return file_.is_open();
	}

private:
	std::ifstream file_;
};

Z7_COM7F_IMF(CreateFileInStream::Read(void *data, UInt32 size, UInt32 *processedSize))
{
	file_.read(static_cast<char *>(data), static_cast<std::streamsize>(size));
	const auto count = file_.gcount();
	if (processedSize != nullptr) {
		*processedSize = static_cast<UInt32>(count);
	}
	return file_.bad() ? E_FAIL : S_OK;
}

class CreateFileOutStream final : public IOutStream, public CMyUnknownImp {
	Z7_COM_QI_BEGIN2(IOutStream)
	Z7_COM_QI_ENTRY(ISequentialOutStream)
	Z7_COM_QI_END
	Z7_COM_ADDREF_RELEASE

	Z7_COM7F_IMP(Write(const void *data, UInt32 size, UInt32 *processedSize))
	Z7_IFACE_COM7_IMP(IOutStream)

public:
	bool Open(const std::string& path)
	{
		path_ = NativePath(path);
		file_.open(path_, std::ios::binary | std::ios::trunc);
		return file_.is_open();
	}

	bool Close()
	{
		file_.flush();
		const bool success = file_.good();
		file_.close();
		return success && !file_.fail();
	}

private:
	std::filesystem::path path_;
	std::ofstream file_;
};

Z7_COM7F_IMF(CreateFileOutStream::Write(
	const void *data, UInt32 size, UInt32 *processedSize))
{
	file_.write(static_cast<const char *>(data), static_cast<std::streamsize>(size));
	if (!file_.good()) {
		return E_FAIL;
	}
	if (processedSize != nullptr) {
		*processedSize = size;
	}
	return S_OK;
}

Z7_COM7F_IMF(CreateFileOutStream::Seek(
	Int64 offset, UInt32 seekOrigin, UInt64 *newPosition))
{
	UInt64 base = 0;
	if (seekOrigin == 1) {
		const auto current = file_.tellp();
		if (current < 0) {
			return E_FAIL;
		}
		base = static_cast<UInt64>(current);
	} else if (seekOrigin == 2) {
		file_.flush();
		if (!file_.good()) {
			return E_FAIL;
		}
		std::error_code error;
		const auto size = std::filesystem::file_size(path_, error);
		if (error) {
			return E_FAIL;
		}
		base = size;
	} else if (seekOrigin != 0) {
		return E_INVALIDARG;
	}
	if (base > static_cast<UInt64>(INT64_MAX)) {
		return E_INVALIDARG;
	}

	UInt64 target = 0;
	if (offset >= 0) {
		const auto advance = static_cast<UInt64>(offset);
		if (advance > static_cast<UInt64>(INT64_MAX) - base) {
			return E_INVALIDARG;
		}
		target = base + advance;
	} else {
		const auto retreat = static_cast<UInt64>(-(offset + 1)) + 1;
		if (retreat > base) {
			return E_INVALIDARG;
		}
		target = base - retreat;
	}
	file_.clear();
	file_.seekp(static_cast<std::streamoff>(target), std::ios::beg);
	if (!file_.good()) {
		return E_FAIL;
	}
	if (newPosition != nullptr) {
		*newPosition = target;
	}
	return S_OK;
}

Z7_COM7F_IMF(CreateFileOutStream::SetSize(UInt64 newSize))
{
	if (newSize > static_cast<UInt64>(INT64_MAX)) {
		return E_INVALIDARG;
	}
	file_.flush();
	if (!file_.good()) {
		return E_FAIL;
	}
	const auto current = file_.tellp();
	std::error_code error;
	std::filesystem::resize_file(path_, newSize, error);
	if (error) {
		return E_FAIL;
	}
	if (current >= 0 && static_cast<UInt64>(current) > newSize) {
		file_.clear();
		file_.seekp(static_cast<std::streamoff>(newSize), std::ios::beg);
		if (!file_.good()) {
			return E_FAIL;
		}
	}
	return S_OK;
}

class ArchiveOpenCallback final :
	public IArchiveOpenCallback,
	public ICryptoGetTextPassword,
	public CMyUnknownImp {
	Z7_COM_QI_BEGIN2(IArchiveOpenCallback)
	Z7_COM_QI_ENTRY(ICryptoGetTextPassword)
	Z7_COM_QI_END
	Z7_COM_ADDREF_RELEASE

	Z7_IFACE_COM7_IMP(IArchiveOpenCallback)
	Z7_IFACE_COM7_IMP(ICryptoGetTextPassword)

public:
	explicit ArchiveOpenCallback(const std::optional<std::string>& password)
		: password_(password), passwordRequested_(false) {}

	bool PasswordRequested() const
	{
		return passwordRequested_.load(std::memory_order_acquire);
	}

private:
	const std::optional<std::string>& password_;
	std::atomic<bool> passwordRequested_;
};

Z7_COM7F_IMF(ArchiveOpenCallback::SetTotal(const UInt64 *, const UInt64 *))
{
	return S_OK;
}

Z7_COM7F_IMF(ArchiveOpenCallback::SetCompleted(const UInt64 *, const UInt64 *))
{
	return S_OK;
}

Z7_COM7F_IMF(ArchiveOpenCallback::CryptoGetTextPassword(BSTR *password))
{
	passwordRequested_.store(true, std::memory_order_release);
	return GetPasswordBstr(password_, password);
}

class ArchiveUpdateCallback final :
	public IArchiveUpdateCallback,
	public CMyUnknownImp {
	Z7_COM_QI_BEGIN2(IArchiveUpdateCallback)
	Z7_COM_QI_ENTRY(IProgress)
	Z7_COM_QI_END
	Z7_COM_ADDREF_RELEASE

	Z7_IFACE_COM7_IMP(IProgress)
	Z7_IFACE_COM7_IMP(IArchiveUpdateCallback)

public:
	explicit ArchiveUpdateCallback(const std::vector<ArchiveCreateItem>& items)
		: items_(items), operationResult_(NArchive::NUpdate::NOperationResult::kOK) {}

	Int32 OperationResult() const
	{
		return operationResult_;
	}

private:
	const std::vector<ArchiveCreateItem>& items_;
	Int32 operationResult_;
};

Z7_COM7F_IMF(ArchiveUpdateCallback::SetTotal(UInt64))
{
	return S_OK;
}

Z7_COM7F_IMF(ArchiveUpdateCallback::SetCompleted(const UInt64 *))
{
	return S_OK;
}

Z7_COM7F_IMF(ArchiveUpdateCallback::GetUpdateItemInfo(
	UInt32 index, Int32 *newData, Int32 *newProperties, UInt32 *indexInArchive))
{
	if (index >= items_.size()) {
		return E_INVALIDARG;
	}
	if (newData != nullptr) {
		*newData = 1;
	}
	if (newProperties != nullptr) {
		*newProperties = 1;
	}
	if (indexInArchive != nullptr) {
		*indexInArchive = static_cast<UInt32>(-1);
	}
	return S_OK;
}

Z7_COM7F_IMF(ArchiveUpdateCallback::GetProperty(
	UInt32 index, PROPID propertyId, PROPVARIANT *value))
{
	if (value == nullptr || index >= items_.size()) {
		return E_INVALIDARG;
	}
	NWindows::NCOM::CPropVariant property;
	try {
		const auto& item = items_[index];
		if (propertyId == kpidPath) {
			const auto path = FromUtf8(item.path);
			property = path.c_str();
		} else if (propertyId == kpidIsDir) {
			property = false;
		} else if (propertyId == kpidMTime) {
			property = UnixMillisecondsToFileTime(item.mtimeMs);
		} else if (propertyId == kpidSize) {
			std::error_code error;
			const auto size = std::filesystem::file_size(NativePath(item.sourcePath), error);
			if (error) {
				return E_FAIL;
			}
			property = static_cast<UInt64>(size);
		}
	} catch (...) {
		return E_INVALIDARG;
	}
	property.Detach(value);
	return S_OK;
}

Z7_COM7F_IMF(ArchiveUpdateCallback::GetStream(
	UInt32 index, ISequentialInStream **inStream))
{
	if (inStream == nullptr || index >= items_.size()) {
		return E_INVALIDARG;
	}
	*inStream = nullptr;
	auto *fileObject = new CreateFileInStream();
	CMyComPtr<ISequentialInStream> file = fileObject;
	if (!fileObject->Open(items_[index].sourcePath)) {
		return E_FAIL;
	}
	*inStream = file;
	(*inStream)->AddRef();
	return S_OK;
}

Z7_COM7F_IMF(ArchiveUpdateCallback::SetOperationResult(Int32 operationResult))
{
	if (operationResult != NArchive::NUpdate::NOperationResult::kOK) {
		operationResult_ = operationResult;
	}
	return S_OK;
}

GUID FindOutputArchiveClassId(const std::string& format)
{
	UInt32 count = 0;
	if (g_getNumberOfFormats(&count) != S_OK) {
		throw std::runtime_error("Unable to enumerate 7-Zip archive handlers");
	}
	for (UInt32 i = 0; i < count; ++i) {
		NWindows::NCOM::CPropVariant name;
		if (g_getHandlerProperty(i, NArchive::NHandlerPropID::kName, &name) != S_OK
			|| name.vt != VT_BSTR || LowerAscii(ToUtf8(name.bstrVal)) != format) {
			continue;
		}
		NWindows::NCOM::CPropVariant classIdValue;
		if (g_getHandlerProperty(i, NArchive::NHandlerPropID::kClassID, &classIdValue) != S_OK
			|| classIdValue.vt != VT_BSTR
			|| ::SysStringByteLen(classIdValue.bstrVal) != sizeof(GUID)) {
			continue;
		}
		GUID classId;
		std::memcpy(&classId, classIdValue.bstrVal, sizeof(classId));
		void *created = nullptr;
		if (g_createObject(&classId, &IID_IOutArchive, &created) == S_OK && created != nullptr) {
			static_cast<IOutArchive *>(created)->Release();
			return classId;
		}
	}
	throw std::runtime_error("The bundled 7-Zip engine has no output handler for format " + format);
}

void CreateArchiveWith7Zip(
	const std::string& outputPath,
	const std::string& format,
	const std::vector<ArchiveCreateItem>& items,
	std::uint32_t compressionLevel,
	const std::string& enginePath)
{
	EnsureEngineLoaded(enginePath);
	const auto classId = FindOutputArchiveClassId(format);
	void *created = nullptr;
	if (g_createObject(&classId, &IID_IOutArchive, &created) != S_OK || created == nullptr) {
		throw std::runtime_error("Unable to create the 7-Zip output handler");
	}
	CMyComPtr<IOutArchive> archive;
	archive.Attach(static_cast<IOutArchive *>(created));

	if (format == "7z" || format == "zip") {
		CMyComPtr<ISetProperties> properties;
		if (archive.QueryInterface(IID_ISetProperties, &properties) != S_OK || !properties) {
			throw std::runtime_error("The 7-Zip output handler does not support compression settings");
		}
		const wchar_t *propertyNames[] = {L"x"};
		NWindows::NCOM::CPropVariant propertyValues[1];
		propertyValues[0] = static_cast<UInt32>(compressionLevel);
		if (properties->SetProperties(propertyNames, propertyValues, 1) != S_OK) {
			throw std::runtime_error("The 7-Zip output handler rejected the compression level");
		}
	}

	auto *outputObject = new CreateFileOutStream();
	CMyComPtr<ISequentialOutStream> output = outputObject;
	if (!outputObject->Open(outputPath)) {
		throw std::runtime_error("Unable to open temporary archive output path");
	}
	auto *callbackObject = new ArchiveUpdateCallback(items);
	CMyComPtr<IArchiveUpdateCallback> callback = callbackObject;
	const auto result = archive->UpdateItems(
		output,
		static_cast<UInt32>(items.size()),
		callback);
	if (result != S_OK) {
		throw std::runtime_error("The 7-Zip handler failed while creating the archive");
	}
	if (callbackObject->OperationResult() != NArchive::NUpdate::NOperationResult::kOK) {
		throw std::runtime_error("The 7-Zip handler failed to read one or more source files");
	}
	if (!outputObject->Close()) {
		throw std::runtime_error("Unable to finish writing the archive output");
	}
}

class VectorOutStream final : public ISequentialOutStream, public CMyUnknownImp {
	Z7_COM_UNKNOWN_IMP_1(ISequentialOutStream)
	Z7_COM7F_IMP(Write(const void *data, UInt32 size, UInt32 *processedSize))

public:
	explicit VectorOutStream(OutputRequest *request): request_(request), seen_(0) {}

private:
	OutputRequest *request_;
	std::uint64_t seen_;
};

Z7_COM7F_IMF(VectorOutStream::Write(const void *data, UInt32 size, UInt32 *processedSize))
{
	const auto start = seen_;
	const auto end = start + size;
	if (end < start) {
		return E_FAIL;
	}
	const auto wantedStart = request_->offset;
	const auto wantedEnd = wantedStart + request_->length;
	const auto copyStart = std::max(start, wantedStart);
	const auto copyEnd = std::min(end, wantedEnd);
	if (copyEnd > copyStart) {
		const auto count = copyEnd - copyStart;
		if (request_->data.size() > request_->maxOutputBytes
			|| count > request_->maxOutputBytes - request_->data.size()) {
			return E_OUTOFMEMORY;
		}
		const auto *bytes = static_cast<const std::uint8_t *>(data);
		request_->data.insert(
			request_->data.end(),
			bytes + static_cast<std::size_t>(copyStart - start),
			bytes + static_cast<std::size_t>(copyEnd - start));
	}
	seen_ = end;
	if (request_->abortOnLimit && request_->data.size() == request_->length) {
		request_->limitReached = true;
		if (processedSize != nullptr) {
			*processedSize = 0;
		}
		return E_ABORT;
	}
	if (processedSize != nullptr) {
		*processedSize = size;
	}
	return S_OK;
}

class ExtractCallback final :
	public IArchiveExtractCallback,
	public ICryptoGetTextPassword,
	public CMyUnknownImp {
	Z7_COM_QI_BEGIN2(IArchiveExtractCallback)
	Z7_COM_QI_ENTRY(IProgress)
	Z7_COM_QI_ENTRY(ICryptoGetTextPassword)
	Z7_COM_QI_END
	Z7_COM_ADDREF_RELEASE

	Z7_IFACE_COM7_IMP(IProgress)
	Z7_IFACE_COM7_IMP(IArchiveExtractCallback)
	Z7_IFACE_COM7_IMP(ICryptoGetTextPassword)

public:
	ExtractCallback(
		std::vector<OutputRequest>& requests,
		const std::unordered_map<std::uint32_t, std::size_t>& requestById,
		const std::optional<std::string>& password)
		: requests_(requests),
			requestById_(requestById),
			password_(password),
			currentRequest_(nullptr),
			passwordRequested_(false) {}

	bool PasswordRequested() const
	{
		return passwordRequested_.load(std::memory_order_acquire);
	}

private:
	std::vector<OutputRequest>& requests_;
	const std::unordered_map<std::uint32_t, std::size_t>& requestById_;
	const std::optional<std::string>& password_;
	OutputRequest *currentRequest_;
	std::vector<CMyComPtr<ISequentialOutStream>> streams_;
	std::atomic<bool> passwordRequested_;
};

Z7_COM7F_IMF(ExtractCallback::SetTotal(UInt64))
{
	return S_OK;
}

Z7_COM7F_IMF(ExtractCallback::SetCompleted(const UInt64 *))
{
	return S_OK;
}

Z7_COM7F_IMF(ExtractCallback::GetStream(
	UInt32 index, ISequentialOutStream **outStream, Int32 askExtractMode))
{
	*outStream = nullptr;
	currentRequest_ = nullptr;
	if (askExtractMode != NArchive::NExtract::NAskMode::kExtract) {
		return S_OK;
	}
	const auto found = requestById_.find(index);
	if (found == requestById_.end()) {
		return S_OK;
	}
	auto& request = requests_[found->second];
	currentRequest_ = &request;
	CMyComPtr<ISequentialOutStream> stream = new VectorOutStream(&request);
	streams_.push_back(stream);
	*outStream = stream;
	(*outStream)->AddRef();
	return S_OK;
}

Z7_COM7F_IMF(ExtractCallback::PrepareOperation(Int32))
{
	return S_OK;
}

Z7_COM7F_IMF(ExtractCallback::SetOperationResult(Int32 operationResult))
{
	if (currentRequest_ != nullptr) {
		currentRequest_->operationResult = currentRequest_->limitReached
			? NArchive::NExtract::NOperationResult::kOK
			: operationResult;
	}
	return S_OK;
}

Z7_COM7F_IMF(ExtractCallback::CryptoGetTextPassword(BSTR *password))
{
	passwordRequested_.store(true, std::memory_order_release);
	return GetPasswordBstr(password_, password);
}

class StreamingOutStream final : public ISequentialOutStream, public CMyUnknownImp {
	Z7_COM_UNKNOWN_IMP_1(ISequentialOutStream)
	Z7_COM7F_IMP(Write(const void *data, UInt32 size, UInt32 *processedSize))

public:
	explicit StreamingOutStream(std::shared_ptr<NativeStreamState> stream)
		: stream_(std::move(stream)) {}

private:
	std::shared_ptr<NativeStreamState> stream_;
};

Z7_COM7F_IMF(StreamingOutStream::Write(
	const void *data, UInt32 size, UInt32 *processedSize))
{
	constexpr UInt32 kStreamChunkSize = 64 * 1024;
	const auto *bytes = static_cast<const std::uint8_t *>(data);
	UInt32 offset = 0;
	try {
		while (offset < size) {
			if (!stream_->WaitForDemand()) {
				return E_ABORT;
			}
			const auto count = std::min(kStreamChunkSize, size - offset);
			auto message = std::make_unique<StreamMessage>();
			message->kind = StreamMessage::Kind::Chunk;
			message->data.assign(bytes + offset, bytes + offset + count);
			if (!stream_->Send(std::move(message))) {
				return E_ABORT;
			}
			offset += count;
		}
	} catch (...) {
		return E_OUTOFMEMORY;
	}
	if (processedSize != nullptr) {
		*processedSize = size;
	}
	return S_OK;
}

class StreamingExtractCallback final :
	public IArchiveExtractCallback,
	public ICryptoGetTextPassword,
	public CMyUnknownImp {
	Z7_COM_QI_BEGIN2(IArchiveExtractCallback)
	Z7_COM_QI_ENTRY(IProgress)
	Z7_COM_QI_ENTRY(ICryptoGetTextPassword)
	Z7_COM_QI_END
	Z7_COM_ADDREF_RELEASE

	Z7_IFACE_COM7_IMP(IProgress)
	Z7_IFACE_COM7_IMP(IArchiveExtractCallback)
	Z7_IFACE_COM7_IMP(ICryptoGetTextPassword)

public:
	StreamingExtractCallback(
		std::uint32_t id,
		std::shared_ptr<NativeStreamState> stream,
		const std::optional<std::string>& password)
		: id_(id),
			stream_(std::move(stream)),
			password_(password),
			operationResult_(NArchive::NExtract::NOperationResult::kUnavailable),
			passwordRequested_(false) {}

	std::int32_t OperationResult() const
	{
		return operationResult_;
	}

	bool PasswordRequested() const
	{
		return passwordRequested_.load(std::memory_order_acquire);
	}

private:
	std::uint32_t id_;
	std::shared_ptr<NativeStreamState> stream_;
	const std::optional<std::string>& password_;
	std::int32_t operationResult_;
	std::vector<CMyComPtr<ISequentialOutStream>> streams_;
	std::atomic<bool> passwordRequested_;
};

Z7_COM7F_IMF(StreamingExtractCallback::SetTotal(UInt64))
{
	return S_OK;
}

Z7_COM7F_IMF(StreamingExtractCallback::SetCompleted(const UInt64 *))
{
	return S_OK;
}

Z7_COM7F_IMF(StreamingExtractCallback::GetStream(
	UInt32 index, ISequentialOutStream **outStream, Int32 askExtractMode))
{
	*outStream = nullptr;
	if (askExtractMode != NArchive::NExtract::NAskMode::kExtract || index != id_) {
		return S_OK;
	}
	CMyComPtr<ISequentialOutStream> stream = new StreamingOutStream(stream_);
	streams_.push_back(stream);
	*outStream = stream;
	(*outStream)->AddRef();
	return S_OK;
}

Z7_COM7F_IMF(StreamingExtractCallback::PrepareOperation(Int32))
{
	return S_OK;
}

Z7_COM7F_IMF(StreamingExtractCallback::SetOperationResult(Int32 operationResult))
{
	operationResult_ = operationResult;
	return S_OK;
}

Z7_COM7F_IMF(StreamingExtractCallback::CryptoGetTextPassword(BSTR *password))
{
	passwordRequested_.store(true, std::memory_order_release);
	return GetPasswordBstr(password_, password);
}

class NativeFileOutputState {
public:
	NativeFileOutputState(std::uint32_t id, std::string path, std::uint64_t expectedSize, bool overwrite)
		: id_(id),
			path_(std::move(path)),
			expectedSize_(expectedSize),
			overwrite_(overwrite) {}

	~NativeFileOutputState()
	{
		Abort();
	}

	bool Open()
	{
		if (overwrite_ && !RemoveOutputFile()) {
			return false;
		}
#ifdef _WIN32
		const auto nativePath = NativePath(path_);
		fileDescriptor_ = ::_wopen(
			nativePath.c_str(),
			_O_WRONLY | _O_CREAT | _O_EXCL | _O_BINARY,
			_S_IREAD | _S_IWRITE);
#else
		const auto nativePath = NativePath(path_);
		int flags = O_WRONLY | O_CREAT | O_EXCL;
#ifdef O_CLOEXEC
		flags |= O_CLOEXEC;
#endif
#ifdef O_NOFOLLOW
		flags |= O_NOFOLLOW;
#endif
		fileDescriptor_ = ::open(nativePath.c_str(), flags, 0600);
#endif
		if (fileDescriptor_ < 0) {
			SetError("Unable to create extraction output file");
			return false;
		}
		fileCreated_ = true;
		return true;
	}

	bool Write(const std::vector<std::uint8_t>& data)
	{
		std::size_t offset = 0;
		while (offset < data.size()) {
#ifdef _WIN32
			const auto written = ::_write(
				fileDescriptor_,
				data.data() + offset,
				static_cast<unsigned int>(data.size() - offset));
#else
			const auto written = ::write(
				fileDescriptor_,
				data.data() + offset,
				data.size() - offset);
#endif
			if (written < 0) {
#ifndef _WIN32
				if (errno == EINTR) {
					continue;
				}
#endif
				SetError("Unable to write extraction output file");
				return false;
			}
			if (written == 0) {
				SetError("Unable to write extraction output file");
				return false;
			}
			const auto count = static_cast<std::size_t>(written);
			offset += count;
			bytesWritten_ += count;
		}
		return true;
	}

	bool Close()
	{
		if (fileDescriptor_ < 0) {
			return error_.empty();
		}
#ifdef _WIN32
		const auto result = ::_close(fileDescriptor_);
#else
		const auto result = ::close(fileDescriptor_);
#endif
		fileDescriptor_ = -1;
		if (result != 0) {
			SetError("Unable to close extraction output file");
			return false;
		}
		return true;
	}

	void Abort()
	{
		Close();
		if (fileCreated_ && !completed_) {
			RemoveOutputFile();
			fileCreated_ = false;
		}
	}

	void MarkCompleted()
	{
		completed_ = true;
	}

	void AddQueuedBytes(std::uint64_t bytes)
	{
		bytesQueued_ += bytes;
	}

	void MarkSizeLimitExceeded()
	{
		sizeLimitExceeded_ = true;
	}

	std::uint32_t Id() const { return id_; }
	std::uint64_t ExpectedSize() const { return expectedSize_; }
	std::uint64_t BytesQueued() const { return bytesQueued_; }
	std::uint64_t BytesWritten() const { return bytesWritten_; }
	bool Completed() const { return completed_; }
	bool SizeLimitExceeded() const { return sizeLimitExceeded_; }
	const std::string& Error() const { return error_; }

private:
	void SetError(const char *message)
	{
		if (error_.empty()) {
			error_ = std::string(message) + ": " + std::strerror(errno);
		}
	}

	bool RemoveOutputFile()
	{
		const auto nativePath = NativePath(path_);
#ifdef _WIN32
		const auto result = ::_wunlink(nativePath.c_str());
#else
		const auto result = ::unlink(nativePath.c_str());
#endif
		if (result == 0 || errno == ENOENT) {
			return true;
		}
		SetError("Unable to remove extraction output file");
		return false;
	}

	std::uint32_t id_;
	std::string path_;
	int fileDescriptor_ = -1;
	std::uint64_t expectedSize_;
	bool overwrite_;
	bool fileCreated_ = false;
	bool completed_ = false;
	std::uint64_t bytesQueued_ = 0;
	std::uint64_t bytesWritten_ = 0;
	bool sizeLimitExceeded_ = false;
	std::string error_;
};

class AsyncFileWriter {
public:
	explicit AsyncFileWriter(std::shared_ptr<NativeFileTaskState> task)
		: task_(std::move(task)) {}

	~AsyncFileWriter()
	{
		StopAndJoin();
	}

	void Start()
	{
		worker_ = std::thread([this] { Run(); });
	}

	bool EnqueueWrite(
		const std::shared_ptr<NativeFileOutputState>& output,
		const std::uint8_t *data,
		std::size_t size)
	{
		try {
			std::vector<std::uint8_t> copy(data, data + size);
			std::unique_lock<std::mutex> lock(mutex_);
			spaceAvailable_.wait(lock, [this, size] {
				return stopping_
					|| task_->IsCancelled()
					|| (HasQueueSpace() && queuedBytes_ + size <= kMaxQueuedBytes);
			});
			if (stopping_ || task_->IsCancelled()) {
				return false;
			}
			queue_.push_back({Job::Kind::Write, output, std::move(copy)});
			queuedBytes_ += size;
		} catch (const std::exception& error) {
			task_->Fail(error.what());
			return false;
		} catch (...) {
			task_->Fail("Unable to queue extraction output data");
			return false;
		}
		workAvailable_.notify_one();
		return true;
	}

	bool EnqueueFinish(const std::shared_ptr<NativeFileOutputState>& output)
	{
		try {
			{
				std::unique_lock<std::mutex> lock(mutex_);
				spaceAvailable_.wait(lock, [this] {
					return stopping_ || HasQueueSpace();
				});
				if (stopping_) {
					return false;
				}
				queue_.push_back({Job::Kind::Finish, output, {}});
			}
			workAvailable_.notify_one();
			return true;
		} catch (const std::exception& error) {
			task_->Fail(error.what());
			return false;
		} catch (...) {
			task_->Fail("Unable to queue extraction output completion");
			return false;
		}
	}

	bool EnqueueAbort(const std::shared_ptr<NativeFileOutputState>& output) noexcept
	{
		try {
			{
				std::unique_lock<std::mutex> lock(mutex_);
				spaceAvailable_.wait(lock, [this] {
					return stopping_ || HasQueueSpace();
				});
				if (stopping_) {
					return false;
				}
				queue_.push_back({Job::Kind::Abort, output, {}});
			}
			workAvailable_.notify_one();
			return true;
		} catch (...) {
			return false;
		}
	}

	void WaitUntilIdle()
	{
		std::unique_lock<std::mutex> lock(mutex_);
		idle_.wait(lock, [this] { return queue_.empty() && !active_; });
	}

	void StopAndJoin()
	{
		{
			std::lock_guard<std::mutex> lock(mutex_);
			stopping_ = true;
		}
		workAvailable_.notify_all();
		spaceAvailable_.notify_all();
		if (worker_.joinable()) {
			worker_.join();
		}
	}

private:
	struct Job {
		enum class Kind {
			Write,
			Finish,
			Abort,
		};

		Kind kind;
		std::shared_ptr<NativeFileOutputState> output;
		std::vector<std::uint8_t> data;
	};

	static constexpr std::size_t kMaxQueuedBytes = 8 * 1024 * 1024;
	static constexpr std::size_t kMaxQueuedJobs = 1024;

	bool HasQueueSpace() const
	{
		return queue_.size() + (active_ ? 1 : 0) < kMaxQueuedJobs;
	}

	void Run() noexcept
	{
		while (true) {
			Job job;
			{
				std::unique_lock<std::mutex> lock(mutex_);
				workAvailable_.wait(lock, [this] {
					return stopping_ || !queue_.empty();
				});
				if (queue_.empty() && stopping_) {
					idle_.notify_all();
					return;
				}
				job = std::move(queue_.front());
				queue_.pop_front();
				active_ = true;
			}

			try {
				Process(job);
			} catch (const std::exception& error) {
				task_->Fail(error.what());
				job.output->Abort();
			} catch (...) {
				task_->Fail("Unknown asynchronous extraction output failure");
				job.output->Abort();
			}

			{
				std::lock_guard<std::mutex> lock(mutex_);
				if (job.kind == Job::Kind::Write) {
					queuedBytes_ -= job.data.size();
				}
				active_ = false;
				if (queue_.empty()) {
					idle_.notify_all();
				}
			}
			spaceAvailable_.notify_all();
		}
	}

	void Process(const Job& job)
	{
		if (job.kind == Job::Kind::Abort) {
			job.output->Abort();
			return;
		}
		if (job.kind == Job::Kind::Write) {
			if (task_->IsCancelled()) {
				return;
			}
			if (!job.output->Write(job.data)) {
				const auto& error = job.output->Error();
				task_->Fail(error.empty() ? "Unable to write extraction output file" : error);
				job.output->Abort();
			}
			return;
		}
		if (task_->IsCancelled()) {
			job.output->Abort();
			return;
		}
		if (!job.output->Close()) {
			const auto& error = job.output->Error();
			task_->Fail(error.empty() ? "Unable to close extraction output file" : error);
			job.output->Abort();
			return;
		}
		job.output->MarkCompleted();
		task_->ReportFileCompleted(job.output->Id());
	}

	std::shared_ptr<NativeFileTaskState> task_;
	std::mutex mutex_;
	std::condition_variable workAvailable_;
	std::condition_variable spaceAvailable_;
	std::condition_variable idle_;
	std::deque<Job> queue_;
	std::size_t queuedBytes_ = 0;
	bool active_ = false;
	bool stopping_ = false;
	std::thread worker_;
};

class NativeFileOutStream final : public ISequentialOutStream, public CMyUnknownImp {
	Z7_COM_UNKNOWN_IMP_1(ISequentialOutStream)
	Z7_COM7F_IMP(Write(const void *data, UInt32 size, UInt32 *processedSize))

public:
	NativeFileOutStream(
		std::shared_ptr<NativeFileOutputState> output,
		AsyncFileWriter& writer,
		std::shared_ptr<NativeFileTaskState> task)
		: output_(std::move(output)),
			writer_(writer),
			task_(std::move(task)) {}

	~NativeFileOutStream()
	{
		if (!terminalQueued_) {
			writer_.EnqueueAbort(output_);
		}
	}

	bool Finish()
	{
		if (terminalQueued_) {
			return true;
		}
		terminalQueued_ = writer_.EnqueueFinish(output_);
		return terminalQueued_;
	}

	void Abort()
	{
		if (!terminalQueued_) {
			terminalQueued_ = writer_.EnqueueAbort(output_);
		}
	}

private:
	std::shared_ptr<NativeFileOutputState> output_;
	AsyncFileWriter& writer_;
	std::shared_ptr<NativeFileTaskState> task_;
	bool terminalQueued_ = false;
};

Z7_COM7F_IMF(NativeFileOutStream::Write(
	const void *data, UInt32 size, UInt32 *processedSize))
{
	if (processedSize != nullptr) {
		*processedSize = 0;
	}
	if (task_->IsCancelled()) {
		return E_ABORT;
	}
	if (size > output_->ExpectedSize() - std::min(
			output_->ExpectedSize(), output_->BytesQueued())) {
		output_->MarkSizeLimitExceeded();
		return E_ABORT;
	}

	const auto *bytes = static_cast<const std::uint8_t *>(data);
	std::uint32_t offset = 0;
	while (offset < size) {
		if (task_->IsCancelled()) {
			return E_ABORT;
		}
		const auto chunkSize = std::min<std::uint32_t>(64 * 1024, size - offset);
		if (!writer_.EnqueueWrite(output_, bytes + offset, chunkSize)) {
			return task_->IsCancelled() ? E_ABORT : E_FAIL;
		}
		output_->AddQueuedBytes(chunkSize);
		offset += chunkSize;
	}
	if (processedSize != nullptr) {
		*processedSize = size;
	}
	return S_OK;
}

struct NativeFileOutputSpec {
	std::uint32_t id = 0;
	std::string path;
	bool overwrite = false;
};

struct FileOutputRequest {
	std::uint32_t id = 0;
	std::string path;
	std::uint64_t expectedSize = 0;
	bool overwrite = false;
	std::int32_t operationResult = NArchive::NExtract::NOperationResult::kUnavailable;
	NativeFileOutStream *stream = nullptr;
	std::shared_ptr<NativeFileOutputState> output;
	std::string error;
};

class BatchFileExtractCallback final :
	public IArchiveExtractCallback,
	public ICryptoGetTextPassword,
	public CMyUnknownImp {
	Z7_COM_QI_BEGIN2(IArchiveExtractCallback)
	Z7_COM_QI_ENTRY(IProgress)
	Z7_COM_QI_ENTRY(ICryptoGetTextPassword)
	Z7_COM_QI_END
	Z7_COM_ADDREF_RELEASE

	Z7_IFACE_COM7_IMP(IProgress)
	Z7_IFACE_COM7_IMP(IArchiveExtractCallback)
	Z7_IFACE_COM7_IMP(ICryptoGetTextPassword)

public:
	BatchFileExtractCallback(
		std::vector<FileOutputRequest>& requests,
		const std::unordered_map<std::uint32_t, std::size_t>& requestById,
		std::shared_ptr<NativeFileTaskState> task,
		AsyncFileWriter& writer,
		const std::optional<std::string>& password)
		: requests_(requests),
			requestById_(requestById),
			task_(std::move(task)),
			writer_(writer),
			password_(password),
			currentRequest_(nullptr),
			passwordRequested_(false) {}

	bool PasswordRequested() const
	{
		return passwordRequested_.load(std::memory_order_acquire);
	}

private:
	std::vector<FileOutputRequest>& requests_;
	const std::unordered_map<std::uint32_t, std::size_t>& requestById_;
	std::shared_ptr<NativeFileTaskState> task_;
	AsyncFileWriter& writer_;
	const std::optional<std::string>& password_;
	FileOutputRequest *currentRequest_;
	std::atomic<bool> passwordRequested_;
	std::vector<CMyComPtr<ISequentialOutStream>> streams_;
};

Z7_COM7F_IMF(BatchFileExtractCallback::SetTotal(UInt64))
{
	return S_OK;
}

Z7_COM7F_IMF(BatchFileExtractCallback::SetCompleted(const UInt64 *))
{
	return task_->IsCancelled() ? E_ABORT : S_OK;
}

Z7_COM7F_IMF(BatchFileExtractCallback::GetStream(
	UInt32 index, ISequentialOutStream **outStream, Int32 askExtractMode))
{
	*outStream = nullptr;
	currentRequest_ = nullptr;
	if (task_->IsCancelled()) {
		return E_ABORT;
	}
	if (askExtractMode != NArchive::NExtract::NAskMode::kExtract) {
		return S_OK;
	}
	const auto found = requestById_.find(index);
	if (found == requestById_.end()) {
		return S_OK;
	}
	auto& request = requests_[found->second];
	currentRequest_ = &request;
	request.output = std::make_shared<NativeFileOutputState>(
		request.id, request.path, request.expectedSize, request.overwrite);
	if (!request.output->Open()) {
		request.error = request.output->Error();
		return E_FAIL;
	}
	auto *fileStream = new NativeFileOutStream(
		request.output, writer_, task_);
	CMyComPtr<ISequentialOutStream> output = fileStream;
	request.stream = fileStream;
	streams_.push_back(output);
	*outStream = output;
	(*outStream)->AddRef();
	return S_OK;
}

Z7_COM7F_IMF(BatchFileExtractCallback::PrepareOperation(Int32))
{
	return task_->IsCancelled() ? E_ABORT : S_OK;
}

Z7_COM7F_IMF(BatchFileExtractCallback::SetOperationResult(Int32 operationResult))
{
	if (currentRequest_ != nullptr) {
		currentRequest_->operationResult = operationResult;
		if (operationResult == NArchive::NExtract::NOperationResult::kOK
			&& currentRequest_->stream != nullptr
			&& currentRequest_->error.empty()
			&& currentRequest_->output != nullptr
			&& !currentRequest_->output->SizeLimitExceeded()) {
			if (!currentRequest_->stream->Finish()) {
				currentRequest_->error = task_->Failure();
				return E_ABORT;
			}
		} else if (currentRequest_->stream != nullptr) {
			currentRequest_->stream->Abort();
		}
	}
	return S_OK;
}

Z7_COM7F_IMF(BatchFileExtractCallback::CryptoGetTextPassword(BSTR *password))
{
	passwordRequested_.store(true, std::memory_order_release);
	return GetPasswordBstr(password_, password);
}

class ArchiveEngine {
	struct ArchiveContext {
		CMyComPtr<IInArchive> archive;
		CMyComPtr<IInStream> stream;
		bool busy = false;

		~ArchiveContext()
		{
			if (archive) {
				archive->Close();
				archive.Release();
			}
			stream.Release();
		}
	};

	struct ContextLease {
		ArchiveEngine *owner;
		ArchiveContext *context;

		ContextLease(ArchiveEngine *owner, ArchiveContext *context)
			: owner(owner), context(context) {}

		ContextLease(const ContextLease&) = delete;
		ContextLease& operator=(const ContextLease&) = delete;

		ContextLease(ContextLease&& other) noexcept
			: owner(other.owner), context(other.context)
		{
			other.context = nullptr;
		}

		~ContextLease()
		{
			if (context != nullptr) {
				owner->ReleaseContext(context);
			}
		}

		ArchiveContext *operator->() const { return context; }
	};

public:
	~ArchiveEngine()
	{
		std::lock_guard<std::mutex> lock(contextMutex_);
		contexts_.clear();
		if (password_) {
			SecureErase(*password_);
			password_.reset();
		}
	}

	void Open(
		const std::string& path,
		std::optional<std::string> password,
		const std::string& enginePath,
		std::uint32_t deflateBufferSize)
	{
		EnsureEngineLoaded(enginePath);
		path_ = path;
		password_ = std::move(password);
		deflateBufferSize_ = deflateBufferSize;
		const auto extension = Extension(path);
		UInt32 formatCount = 0;
		if (g_getNumberOfFormats(&formatCount) != S_OK || formatCount == 0) {
			throw std::runtime_error("The 7-Zip handler bundle contains no formats");
		}

		struct Format {
			UInt32 index;
			GUID classId;
			std::string name;
			bool extensionMatch;
			bool contentMatch;
			unsigned probePriority;
		};
		std::vector<Format> formats;
		formats.reserve(formatCount);
		std::vector<Byte> header(1 << 20);
		CMyComPtr<IInStream> probe;
		if (memoryInput_) {
			probe = new MemoryInStream(memoryData_);
		} else {
			auto *probeFile = new FileInStream();
			probe = probeFile;
			if (!probeFile->Open(path)) {
				throw std::runtime_error("Unable to open archive path");
			}
		}
		UInt32 headerSize = 0;
		if (probe->Read(header.data(), static_cast<UInt32>(header.size()), &headerSize) != S_OK) {
			throw std::runtime_error("Unable to read archive signature");
		}
		if (headerSize == 0) {
			throw std::runtime_error("Archive file is empty");
		}
		const auto sourceSize = memoryInput_ ? memoryData_.size() : GetFileStamp(path).size;
		const bool endOfFile = headerSize < header.size() || sourceSize <= headerSize;
		for (UInt32 i = 0; i < formatCount; ++i) {
			NWindows::NCOM::CPropVariant classIdValue;
			if (g_getHandlerProperty(i, NArchive::NHandlerPropID::kClassID, &classIdValue) != S_OK
				|| classIdValue.vt != VT_BSTR
				|| ::SysStringByteLen(classIdValue.bstrVal) != sizeof(GUID)) {
				continue;
			}
			GUID classId;
			std::memcpy(&classId, classIdValue.bstrVal, sizeof(classId));
			NWindows::NCOM::CPropVariant nameValue;
			std::string name;
			if (g_getHandlerProperty(i, NArchive::NHandlerPropID::kName, &nameValue) == S_OK
				&& nameValue.vt == VT_BSTR) {
				name = ToUtf8(nameValue.bstrVal);
			}
			bool match = false;
			for (const auto propId : {
				NArchive::NHandlerPropID::kExtension,
				NArchive::NHandlerPropID::kAddExtension
			}) {
				NWindows::NCOM::CPropVariant extensions;
				if (g_getHandlerProperty(i, propId, &extensions) == S_OK
					&& extensions.vt == VT_BSTR && !extension.empty()) {
					const auto list = SplitExtensions(extensions.bstrVal);
					match = match || std::find(list.begin(), list.end(), extension) != list.end();
				}
			}
			Func_IsArc isArchive = nullptr;
			const bool hasSignatureFunction = g_getIsArc(i, &isArchive) == S_OK && isArchive != nullptr;
			constexpr UInt32 kStartOpenFlags =
				NArcInfoFlags::kStartOpen
				| NArcInfoFlags::kPureStartOpen
				| NArcInfoFlags::kBackwardOpen;
			NWindows::NCOM::CPropVariant flagsValue;
			const bool hasFlags = g_getHandlerProperty(
				i, NArchive::NHandlerPropID::kFlags, &flagsValue) == S_OK
				&& flagsValue.vt == VT_UI4;
			const UInt32 flags = hasFlags ? flagsValue.ulVal : 0;
			if (!match && (flags & NArcInfoFlags::kByExtOnlyOpen) != 0) {
				continue;
			}

			bool contentMatch = false;
			unsigned probePriority = match ? 0 : 2;
			if (hasSignatureFunction) {
				const auto result = isArchive(header.data(), headerSize);
				contentMatch = result == k_IsArc_Res_YES
					|| (result == k_IsArc_Res_NEED_MORE && !endOfFile);
				if (!match && contentMatch) {
					probePriority = 1;
				} else if (!match && !contentMatch) {
					continue;
				}
			} else {
				NWindows::NCOM::CPropVariant signatureOffsetValue;
				UInt32 signatureOffset = 0;
				if (g_getHandlerProperty(
					i, NArchive::NHandlerPropID::kSignatureOffset, &signatureOffsetValue) == S_OK
					&& signatureOffsetValue.vt == VT_UI4) {
					signatureOffset = signatureOffsetValue.ulVal;
				}
				std::vector<std::vector<Byte>> signatures;
				NWindows::NCOM::CPropVariant signatureValue;
				if (g_getHandlerProperty(i, NArchive::NHandlerPropID::kSignature, &signatureValue) == S_OK
					&& signatureValue.vt == VT_BSTR
					&& ::SysStringByteLen(signatureValue.bstrVal) != 0) {
					const auto *data = reinterpret_cast<const Byte *>(signatureValue.bstrVal);
					const auto size = ::SysStringByteLen(signatureValue.bstrVal);
					signatures.emplace_back(data, data + size);
				} else {
					NWindows::NCOM::CPropVariant multiSignatureValue;
					if (g_getHandlerProperty(
						i, NArchive::NHandlerPropID::kMultiSignature, &multiSignatureValue) == S_OK
						&& multiSignatureValue.vt == VT_BSTR) {
						const auto *data = reinterpret_cast<const Byte *>(multiSignatureValue.bstrVal);
						const auto size = ::SysStringByteLen(multiSignatureValue.bstrVal);
						for (UINT offset = 0; offset < size;) {
							const auto signatureSize = data[offset++];
							if (signatureSize > size - offset) {
								signatures.clear();
								break;
							}
							signatures.emplace_back(data + offset, data + offset + signatureSize);
							offset += signatureSize;
						}
					}
				}

				bool signatureMatch = false;
				bool needCheck = !hasFlags || signatures.empty()
					|| (flags & kStartOpenFlags) != 0 || signatureOffset != 0;
				const auto signatureOffsetSize = static_cast<std::size_t>(signatureOffset);
				for (const auto& signature : signatures) {
					if (signatureOffsetSize > headerSize
						|| signature.size() > headerSize - signatureOffsetSize) {
						if (!endOfFile) {
							needCheck = true;
						}
					} else if (std::memcmp(
						header.data() + signatureOffsetSize, signature.data(), signature.size()) == 0) {
						signatureMatch = true;
						break;
					}
				}
				contentMatch = signatureMatch;
				if (!match && signatureMatch) {
					probePriority = 1;
				} else if (!match && !needCheck) {
					continue;
				}
			}
			formats.push_back({i, classId, std::move(name), match, contentMatch, probePriority});
		}
		if (formats.empty()) {
			throw std::runtime_error("No registered 7-Zip handler recognizes this archive");
		}
		std::stable_sort(formats.begin(), formats.end(), [](const Format& left, const Format& right) {
			return left.probePriority < right.probePriority;
		});

		bool passwordRequested = false;
		HRESULT lastOpenResult = E_FAIL;
		UInt32 lastFormatIndex = 0;
		std::string lastFormatName;
		for (const auto& format : formats) {
			lastFormatIndex = format.index;
			lastFormatName = format.name;
			CMyComPtr<IInStream> input;
			if (memoryInput_) {
				input = new MemoryInStream(memoryData_);
			} else {
				auto *inputFile = new FileInStream();
				input = inputFile;
				if (!inputFile->Open(path)) {
					throw std::runtime_error("Unable to open archive path");
				}
			}
			void *created = nullptr;
			const auto createResult = g_createObject(&format.classId, &IID_IInArchive, &created);
			if (createResult != S_OK || created == nullptr) {
				continue;
			}
			CMyComPtr<IInArchive> candidate;
			candidate.Attach(static_cast<IInArchive *>(created));
			const UInt64 maxCheckStartPosition = 0;
			auto *openCallbackObject = new ArchiveOpenCallback(password_);
			CMyComPtr<IArchiveOpenCallback> openCallback = openCallbackObject;
			lastOpenResult = candidate->Open(input, &maxCheckStartPosition, openCallback);
			if (lastOpenResult != S_OK) {
				passwordRequested = passwordRequested || openCallbackObject->PasswordRequested();
				candidate->Close();
				continue;
			}
			if (!HasValidEntryPaths(candidate) && !format.contentMatch
				&& LowerAscii(format.name) != "gzip") {
				candidate->Close();
				continue;
			}
			auto context = std::make_unique<ArchiveContext>();
			context->archive = candidate;
			context->stream = input;
			archiveClassId_ = format.classId;
			contexts_.push_back(std::move(context));
			LoadEntries(contexts_.front()->archive);
			if (!memoryInput_) {
				fileStamp_ = GetFileStamp(path_);
				if (IsCompressedTarPath(path_)) {
					OpenNestedTar(enginePath);
				}
			}
			return;
		}
		if (passwordRequested) {
			throw std::runtime_error("Archive password is missing or incorrect");
		}
		throw std::runtime_error(
			"No 7-Zip archive handler recognized this file (format "
			+ lastFormatName
			+ " "
			+ std::to_string(lastFormatIndex)
			+ ", HRESULT "
			+ std::to_string(static_cast<std::uint32_t>(lastOpenResult))
			+ ")");
	}

	const std::vector<Entry>& Entries() const
	{
		return entries_;
	}

	std::vector<std::vector<std::uint8_t>> Extract(
		const std::vector<std::uint32_t>& ids,
		const std::vector<ReadRange>& ranges,
		OutputReservation& outputReservation,
		ExtractionProfile *profile = nullptr)
	{
		using Clock = std::chrono::steady_clock;
		const auto elapsedMs = [](Clock::time_point start) {
			return std::chrono::duration<double, std::milli>(Clock::now() - start).count();
		};
		Clock::time_point phaseStart;
		if (contexts_.empty()) {
			throw std::runtime_error("Archive is closed");
		}
		if (!ranges.empty() && ranges.size() != ids.size()) {
			throw std::invalid_argument("Read ranges must match the requested entry count");
		}
		std::unordered_map<std::uint32_t, std::size_t> requestById;
		requestById.reserve(ids.size());
		std::uint64_t totalRequested = 0;
		if (profile != nullptr) {
			phaseStart = Clock::now();
		}
		for (std::size_t requestIndex = 0; requestIndex < ids.size(); ++requestIndex) {
			const auto id = ids[requestIndex];
			if (id >= entries_.size()) {
				throw std::out_of_range("Entry ID is out of range");
			}
			const auto& entry = entries_[id];
			if (entry.directory) {
				throw std::invalid_argument("Cannot read a directory entry");
			}
			const bool partial = !ranges.empty();
			const auto start = partial ? std::min(ranges[requestIndex].offset, entry.size) : 0;
			const auto available = entry.size - start;
			const auto requested = partial ? std::min(ranges[requestIndex].length, available) : entry.size;
			if (!requestById.emplace(id, requestIndex).second) {
				throw std::invalid_argument("Duplicate entry IDs are not allowed in a batch");
			}
			if (requested > kMaxSingleOutputBytes
				|| requested > kMaxSingleOutputBytes - totalRequested) {
				throw std::length_error("Entry exceeds the in-memory output limit");
			}
			totalRequested += requested;
		}
		if (profile != nullptr) {
			profile->validationMs = elapsedMs(phaseStart);
			phaseStart = Clock::now();
		}
		outputReservation.Acquire(totalRequested);
		if (profile != nullptr) {
			profile->reservationMs = elapsedMs(phaseStart);
			phaseStart = Clock::now();
		}
		std::vector<OutputRequest> requests;
		requests.reserve(ids.size());
		for (std::size_t requestIndex = 0; requestIndex < ids.size(); ++requestIndex) {
			const auto id = ids[requestIndex];
			const auto& entry = entries_[id];
			const bool partial = !ranges.empty();
			const auto start = partial ? std::min(ranges[requestIndex].offset, entry.size) : 0;
			const auto available = entry.size - start;
			const auto requested = partial ? std::min(ranges[requestIndex].length, available) : entry.size;
			OutputRequest request;
			request.id = id;
			request.offset = start;
			request.length = requested;
			request.entrySize = entry.size;
			request.encrypted = entry.encrypted;
			request.data.reserve(static_cast<std::size_t>(requested));
			requests.push_back(std::move(request));
		}
		std::vector<UInt32> sortedIds;
		sortedIds.reserve(requestById.size());
		for (const auto& item : requestById) {
			auto& request = requests[item.second];
			if (!ranges.empty() && request.length == 0) {
				request.operationResult = NArchive::NExtract::NOperationResult::kOK;
				continue;
			}
			sortedIds.push_back(item.first);
		}
		if (std::all_of(requests.begin(), requests.end(), [](const OutputRequest& request) {
			return request.length == 0;
		})) {
			return std::vector<std::vector<std::uint8_t>>(ids.size());
		}
		std::sort(sortedIds.begin(), sortedIds.end());
		if (profile != nullptr) {
			profile->requestSetupMs = elapsedMs(phaseStart);
			phaseStart = Clock::now();
		}
		auto context = AcquireContext();
		if (profile != nullptr) {
			profile->contextAcquireMs = elapsedMs(phaseStart);
			phaseStart = Clock::now();
		}
		const bool abortPerItem = !ranges.empty() && !IsSolidArchive(context->archive);
		if (profile != nullptr) {
			profile->solidCheckMs = elapsedMs(phaseStart);
			profile->abortPerItem = abortPerItem;
			phaseStart = Clock::now();
		}
		if (abortPerItem) {
			for (auto& request : requests) {
				request.abortOnLimit = request.offset + request.length < request.entrySize;
			}
		}
		auto *extractCallbackObject = new ExtractCallback(requests, requestById, password_);
		CMyComPtr<IArchiveExtractCallback> callback = extractCallbackObject;
		if (profile != nullptr) {
			profile->callbackSetupMs = elapsedMs(phaseStart);
			phaseStart = Clock::now();
		}
		HRESULT result = S_OK;
		if (g_setDeflateInputBufferSize(deflateBufferSize_) != S_OK) {
			throw std::runtime_error("Unable to configure the Deflate input buffer");
		}
		if (abortPerItem) {
			for (const auto id : sortedIds) {
				const auto requestIndex = requestById.at(id);
				const UInt32 itemId = id;
				const auto callStart = profile != nullptr ? Clock::now() : Clock::time_point{};
				const auto itemResult = context->archive->Extract(&itemId, 1, 0, callback);
				if (profile != nullptr) {
					const double callMs = elapsedMs(callStart);
					if (profile->sevenZipCalls == 0 || callMs < profile->minSevenZipCallMs) {
						profile->minSevenZipCallMs = callMs;
					}
					profile->maxSevenZipCallMs = std::max(profile->maxSevenZipCallMs, callMs);
					++profile->sevenZipCalls;
				}
				if (itemResult == E_ABORT && requests[requestIndex].limitReached) {
					requests[requestIndex].operationResult = NArchive::NExtract::NOperationResult::kOK;
					continue;
				}
				if (itemResult != S_OK) {
					result = itemResult;
					break;
				}
			}
		} else {
			const auto callStart = profile != nullptr ? Clock::now() : Clock::time_point{};
			result = context->archive->Extract(
				sortedIds.empty() ? nullptr : sortedIds.data(),
				static_cast<UInt32>(sortedIds.size()),
				0,
				callback);
			if (profile != nullptr) {
				const double callMs = elapsedMs(callStart);
				profile->sevenZipCalls = 1;
				profile->minSevenZipCallMs = callMs;
				profile->maxSevenZipCallMs = callMs;
			}
		}
		if (profile != nullptr) {
			profile->sevenZipExtractMs = elapsedMs(phaseStart);
			phaseStart = Clock::now();
		}
		if (result != S_OK) {
			if (extractCallbackObject->PasswordRequested()) {
				throw std::runtime_error("Archive password is missing or incorrect");
			}
			throw std::runtime_error("7-Zip failed to extract the requested entries");
		}
		for (const auto& request : requests) {
			if (request.operationResult != NArchive::NExtract::NOperationResult::kOK) {
				if (request.encrypted && extractCallbackObject->PasswordRequested()) {
					throw std::runtime_error("Archive password is incorrect or encrypted data is invalid");
				}
				if (request.operationResult == NArchive::NExtract::NOperationResult::kWrongPassword) {
					throw std::runtime_error("Archive password is incorrect");
				}
				throw std::runtime_error("Entry extraction failed (unsupported method, integrity error, or password required)");
			}
		}
		std::vector<std::vector<std::uint8_t>> resultData;
		resultData.reserve(ids.size());
		for (const auto id : ids) {
			resultData.push_back(std::move(requests[requestById.at(id)].data));
		}
		if (profile != nullptr) {
			profile->resultProcessingMs = elapsedMs(phaseStart);
		}
		return resultData;
	}

	void ExtractStream(std::uint32_t id, const std::shared_ptr<NativeStreamState>& stream)
	{
		if (contexts_.empty()) {
			throw std::runtime_error("Archive is closed");
		}
		if (id >= entries_.size()) {
			throw std::out_of_range("Entry ID is out of range");
		}
		if (entries_[id].directory) {
			throw std::invalid_argument("Cannot read a directory entry");
		}
		auto context = AcquireContext();
		auto *extractCallbackObject = new StreamingExtractCallback(id, stream, password_);
		CMyComPtr<IArchiveExtractCallback> callback = extractCallbackObject;
		const UInt32 itemIndex = id;
		if (g_setDeflateInputBufferSize(deflateBufferSize_) != S_OK) {
			throw std::runtime_error("Unable to configure the Deflate input buffer");
		}
		const auto result = context->archive->Extract(&itemIndex, 1, 0, callback);
		if (result != S_OK) {
			if (extractCallbackObject->PasswordRequested()) {
				throw std::runtime_error("Archive password is missing or incorrect");
			}
			throw std::runtime_error("7-Zip failed to stream the requested entry");
		}
		if (extractCallbackObject->OperationResult() != NArchive::NExtract::NOperationResult::kOK) {
			if (extractCallbackObject->PasswordRequested()) {
				throw std::runtime_error("Archive password is incorrect or encrypted data is invalid");
			}
			if (extractCallbackObject->OperationResult()
				== NArchive::NExtract::NOperationResult::kWrongPassword) {
				throw std::runtime_error("Archive password is incorrect");
			}
			throw std::runtime_error(
				"Entry streaming failed (unsupported method, integrity error, or password required)");
		}
	}

	void ExtractToFiles(
		const std::vector<NativeFileOutputSpec>& outputs,
		const std::shared_ptr<NativeFileTaskState>& task,
		AsyncFileWriter& writer)
	{
		if (contexts_.empty()) {
			throw std::runtime_error("Archive is closed");
		}
		if (task->IsCancelled()) {
			const auto failure = task->Failure();
			throw std::runtime_error(failure.empty()
				? "Native folder extraction was cancelled"
				: failure);
		}
		if (outputs.empty()) {
			return;
		}

		std::vector<FileOutputRequest> requests;
		requests.reserve(outputs.size());
		std::unordered_map<std::uint32_t, std::size_t> requestById;
		requestById.reserve(outputs.size());
		std::vector<UInt32> sortedIds;
		sortedIds.reserve(outputs.size());
		for (const auto& output : outputs) {
			const auto id = output.id;
			const auto& path = output.path;
			if (id >= entries_.size()) {
				throw std::out_of_range("Entry ID is out of range");
			}
			if (entries_[id].directory) {
				throw std::invalid_argument("Cannot extract a directory entry to a file");
			}
			if (path.empty() || path.find('\0') != std::string::npos) {
				throw std::invalid_argument("Extraction output paths must be non-empty and contain no null bytes");
			}
			if (!requestById.emplace(id, requests.size()).second) {
				throw std::invalid_argument("Duplicate entry IDs are not allowed in a folder extraction batch");
			}
			requests.push_back({
				id,
				path,
				entries_[id].size,
				output.overwrite,
				NArchive::NExtract::NOperationResult::kUnavailable,
				nullptr,
				nullptr,
				{},
			});
			sortedIds.push_back(id);
		}
		std::sort(sortedIds.begin(), sortedIds.end());

		HRESULT result = E_FAIL;
		bool passwordRequested = false;
		{
			auto context = AcquireContext();
			auto *extractCallbackObject = new BatchFileExtractCallback(
				requests, requestById, task, writer, password_);
			CMyComPtr<IArchiveExtractCallback> callback = extractCallbackObject;
			if (g_setDeflateInputBufferSize(deflateBufferSize_) != S_OK) {
				throw std::runtime_error("Unable to configure the Deflate input buffer");
			}
			result = context->archive->Extract(
				sortedIds.data(),
				static_cast<UInt32>(sortedIds.size()),
				0,
				callback);
			passwordRequested = extractCallbackObject->PasswordRequested();
		}
		writer.WaitUntilIdle();
		const auto writerFailure = task->Failure();
		if (!writerFailure.empty()) {
			throw std::runtime_error(writerFailure);
		}
		if (task->IsCancelled()) {
			throw std::runtime_error("Native folder extraction was cancelled");
		}
		for (const auto& request : requests) {
			if (!request.error.empty()) {
				throw std::runtime_error(request.error);
			}
			if (request.output != nullptr && request.output->SizeLimitExceeded()) {
				throw std::runtime_error(
					"Extracted entry exceeds its declared size: " + request.path);
			}
		}
		if (result != S_OK) {
			if (passwordRequested) {
				throw std::runtime_error("Archive password is missing or incorrect");
			}
			throw std::runtime_error("7-Zip failed to extract the requested files");
		}
		for (const auto& request : requests) {
			if (request.operationResult != NArchive::NExtract::NOperationResult::kOK) {
				if (passwordRequested) {
					throw std::runtime_error("Archive password is incorrect or encrypted data is invalid");
				}
				if (request.operationResult == NArchive::NExtract::NOperationResult::kWrongPassword) {
					throw std::runtime_error("Archive password is incorrect");
				}
				throw std::runtime_error(
					"Entry extraction failed (unsupported method, integrity error, or password required): "
					+ request.path);
			}
			if (request.output == nullptr || !request.output->Completed()) {
				throw std::runtime_error("Entry output did not finish writing: " + request.path);
			}
			if (request.output->BytesWritten() != request.output->BytesQueued()) {
				throw std::runtime_error("Entry output write count is inconsistent: " + request.path);
			}
		}
	}

private:
	std::vector<std::uint8_t> DecodeEntryForNestedTar(std::uint32_t id)
	{
		OutputRequest request;
		request.id = id;
		request.length = kMaxNestedTarBytes;
		request.entrySize = kMaxNestedTarBytes;
		request.maxOutputBytes = kMaxNestedTarBytes;
		request.abortOnLimit = true;
		std::vector<OutputRequest> requests;
		requests.push_back(std::move(request));
		std::unordered_map<std::uint32_t, std::size_t> requestById{{id, 0}};
		auto *callbackObject = new ExtractCallback(requests, requestById, password_);
		CMyComPtr<IArchiveExtractCallback> callback = callbackObject;
		if (g_setDeflateInputBufferSize(deflateBufferSize_) != S_OK) {
			throw std::runtime_error("Unable to configure the Deflate input buffer");
		}
		const UInt32 itemIndex = id;
		const auto result = contexts_.front()->archive->Extract(&itemIndex, 1, 0, callback);
		auto& output = requests.front();
		if (callbackObject->PasswordRequested()) {
			throw std::runtime_error("Archive password is missing or incorrect");
		}
		if (output.limitReached) {
			throw std::length_error("Decoded archive exceeds the in-memory output limit");
		}
		if (result != S_OK && output.data.empty()) {
			throw std::runtime_error("Unable to decode the compressed TAR stream");
		}
		if (output.operationResult != NArchive::NExtract::NOperationResult::kOK
			&& output.data.empty()) {
			throw std::runtime_error("Unable to decode the compressed TAR stream");
		}
		return std::move(output.data);
	}

	void OpenNestedTar(const std::string& enginePath)
	{
		std::uint32_t fileId = 0;
		bool foundFile = false;
		for (const auto& entry : entries_) {
			if (entry.directory) {
				continue;
			}
			if (foundFile || entry.encrypted) {
				return;
			}
			fileId = entry.id;
			foundFile = true;
		}
		if (!foundFile) {
			return;
		}
		auto tarData = DecodeEntryForNestedTar(fileId);
		if (!HasTarHeader(tarData)) {
			return;
		}
		const auto decodedPath = path_ + ".decoded.tar";
		contexts_.clear();
		entries_.clear();
		memoryData_ = std::move(tarData);
		memoryInput_ = true;
		Open(decodedPath, password_, enginePath, deflateBufferSize_);
	}

	bool HasValidEntryPaths(IInArchive *archive) const
	{
		UInt32 count = 0;
		if (archive->GetNumberOfItems(&count) != S_OK || count > kMaxEntries) {
			return false;
		}
		for (UInt32 i = 0; i < count; ++i) {
			if (GetPropString(archive, i, kpidPath).empty()) {
				return false;
			}
		}
		return true;
	}

	ContextLease AcquireContext()
	{
		std::unique_lock<std::mutex> lock(contextMutex_);
		while (true) {
			for (const auto& context : contexts_) {
				if (!context->busy) {
					context->busy = true;
					return ContextLease(this, context.get());
				}
			}
			const auto contextLimit = std::max<std::uint32_t>(
				1, g_extractionConcurrency.load(std::memory_order_acquire));
			if (contexts_.size() + contextsCreating_ < contextLimit) {
				++contextsCreating_;
				lock.unlock();
				std::unique_ptr<ArchiveContext> context;
				try {
					context = OpenAdditionalContext();
				} catch (...) {
					lock.lock();
					--contextsCreating_;
					contextAvailable_.notify_all();
					throw;
				}
				lock.lock();
				--contextsCreating_;
				context->busy = true;
				auto *result = context.get();
				contexts_.push_back(std::move(context));
				contextAvailable_.notify_all();
				return ContextLease(this, result);
			}
			contextAvailable_.wait(lock);
		}
	}

	void ReleaseContext(ArchiveContext *context)
	{
		{
			std::lock_guard<std::mutex> lock(contextMutex_);
			context->busy = false;
		}
		contextAvailable_.notify_one();
	}

	std::unique_ptr<ArchiveContext> OpenAdditionalContext()
	{
		if (!memoryInput_) {
			const auto beforeOpen = GetFileStamp(path_);
			if (beforeOpen.size != fileStamp_.size
				|| beforeOpen.modified != fileStamp_.modified) {
				throw std::runtime_error("Archive file changed since opening; reopen it before extracting");
			}
		}
		CMyComPtr<IInStream> input;
		if (memoryInput_) {
			input = new MemoryInStream(memoryData_);
		} else {
			auto *inputFile = new FileInStream();
			input = inputFile;
			if (!inputFile->Open(path_)) {
				throw std::runtime_error("Unable to reopen archive path for concurrent extraction");
			}
		}
		void *created = nullptr;
		const auto createResult = g_createObject(&archiveClassId_, &IID_IInArchive, &created);
		if (createResult != S_OK || created == nullptr) {
			throw std::runtime_error("Unable to create an independent 7-Zip decoder context");
		}
		CMyComPtr<IInArchive> archive;
		archive.Attach(static_cast<IInArchive *>(created));
		const UInt64 maxCheckStartPosition = 0;
		auto *openCallbackObject = new ArchiveOpenCallback(password_);
		CMyComPtr<IArchiveOpenCallback> openCallback = openCallbackObject;
		const auto openResult = archive->Open(input, &maxCheckStartPosition, openCallback);
		if (openResult != S_OK) {
			const bool passwordRequested = openCallbackObject->PasswordRequested();
			archive->Close();
			if (passwordRequested) {
				throw std::runtime_error("Archive password is missing or incorrect");
			}
			throw std::runtime_error("Unable to open an independent 7-Zip decoder context");
		}
		if (!memoryInput_) {
			const auto stamp = GetFileStamp(path_);
			if (stamp.size != fileStamp_.size || stamp.modified != fileStamp_.modified) {
				archive->Close();
				throw std::runtime_error("Archive file changed during concurrent extraction setup");
			}
		}
		auto context = std::make_unique<ArchiveContext>();
		context->archive = archive;
		context->stream = input;
		return context;
	}

	void LoadEntries(IInArchive *archive)
	{
		UInt32 count = 0;
		if (archive->GetNumberOfItems(&count) != S_OK || count > kMaxEntries) {
			throw std::runtime_error("Invalid or excessively large archive index");
		}
		entries_.reserve(count);
		for (UInt32 i = 0; i < count; ++i) {
			Entry entry;
			entry.id = i;
			entry.path = GetPropString(archive, i, kpidPath);
			std::replace(entry.path.begin(), entry.path.end(), '\\', '/');
			entry.size = GetPropUInt64(archive, i, kpidSize);
			entry.compressedSize = GetPropUInt64(archive, i, kpidPackSize);
			entry.attributes = static_cast<std::uint32_t>(GetPropUInt64(archive, i, kpidAttrib));
			entry.directory = GetPropBool(archive, i, kpidIsDir);
			entry.encrypted = GetPropBool(archive, i, kpidEncrypted);
			NWindows::NCOM::CPropVariant crc;
			if (archive->GetProperty(i, kpidCRC, &crc) == S_OK && crc.vt == VT_UI4) {
				entry.crc = crc.ulVal;
				entry.hasCrc = true;
			}
			entries_.push_back(std::move(entry));
		}
	}

	std::mutex contextMutex_;
	std::condition_variable contextAvailable_;
	std::vector<std::unique_ptr<ArchiveContext>> contexts_;
	std::size_t contextsCreating_ = 0;
	std::string path_;
	std::vector<std::uint8_t> memoryData_;
	bool memoryInput_ = false;
	GUID archiveClassId_{};
	FileStamp fileStamp_{};
	std::optional<std::string> password_;
	std::vector<Entry> entries_;
	std::uint32_t deflateBufferSize_ = 32 * 1024;
};

Napi::Object EntryToJs(Napi::Env env, const Entry& entry)
{
	Napi::Object result = Napi::Object::New(env);
	result.Set("id", Napi::Number::New(env, entry.id));
	result.Set("path", Napi::String::New(env, entry.path));
	result.Set("size", Napi::BigInt::New(env, entry.size));
	result.Set("compressedSize", Napi::BigInt::New(env, entry.compressedSize));
	result.Set("isDirectory", Napi::Boolean::New(env, entry.directory));
	result.Set("encrypted", Napi::Boolean::New(env, entry.encrypted));
	result.Set("attributes", Napi::Number::New(env, entry.attributes));
	if (entry.hasCrc) {
		result.Set("crc", Napi::Number::New(env, entry.crc));
	}
	return result;
}

Napi::Buffer<std::uint8_t> TakeBuffer(Napi::Env env, std::vector<std::uint8_t> data)
{
	if (data.empty()) {
		return Napi::Buffer<std::uint8_t>::New(env, 0);
	}
	auto *owned = new std::vector<std::uint8_t>(std::move(data));
	return Napi::Buffer<std::uint8_t>::NewOrCopy(
		env,
		owned->data(),
		owned->size(),
		[](Napi::Env, std::uint8_t *, std::vector<std::uint8_t> *hint) {
			delete hint;
		},
		owned);
}

void StreamMessageToJs(Napi::Env env, Napi::Function callback, StreamMessage *message)
{
	std::unique_ptr<StreamMessage> owned(message);
	if (env == nullptr || !callback) {
		return;
	}
	if (message->kind == StreamMessage::Kind::Chunk) {
		callback.Call({
			TakeBuffer(env, std::move(message->data)),
			env.Undefined(),
			Napi::Boolean::New(env, false)
		});
	} else if (message->kind == StreamMessage::Kind::Error) {
		callback.Call({
			env.Undefined(),
			Napi::Error::New(env, message->error).Value(),
			Napi::Boolean::New(env, false)
		});
	} else {
		callback.Call({
			env.Undefined(),
			env.Undefined(),
			Napi::Boolean::New(env, true)
		});
	}
}

void FileCompletionToJs(
	Napi::Env env,
	Napi::Function callback,
	FileCompletionMessage *message)
{
	std::unique_ptr<FileCompletionMessage> owned(message);
	if (message->kind == FileCompletionMessage::Kind::Barrier) {
		message->acknowledgement->Acknowledge();
		return;
	}
	if (env != nullptr && callback) {
		callback.Call({Napi::Number::New(env, message->entryId)});
	}
}

class BoundedAsyncWorker : public Napi::AsyncWorker {
public:
	BoundedAsyncWorker(Napi::Env env, Napi::Promise::Deferred deferred)
		: Napi::AsyncWorker(env), deferred_(deferred) {}

	~BoundedAsyncWorker() override
	{
		g_pendingOperations.fetch_sub(1, std::memory_order_acq_rel);
	}

	void OnError(const Napi::Error& error) override
	{
		deferred_.Reject(error.Value());
	}

protected:
	Napi::Promise::Deferred deferred_;
};

class OpenWorker final : public BoundedAsyncWorker {
public:
	OpenWorker(
		Napi::Env env,
		Napi::Promise::Deferred deferred,
		std::string path,
		std::optional<std::string> password,
		std::string enginePath,
		std::uint32_t deflateBufferSize)
		: BoundedAsyncWorker(env, deferred),
			path_(std::move(path)),
			password_(std::move(password)),
			enginePath_(std::move(enginePath)),
			deflateBufferSize_(deflateBufferSize) {}

	~OpenWorker() override
	{
		if (password_) {
			SecureErase(*password_);
		}
	}

	void Execute() override
	{
		try {
			archive_ = std::make_shared<ArchiveEngine>();
			archive_->Open(path_, std::move(password_), enginePath_, deflateBufferSize_);
		} catch (const std::exception& error) {
			SetError(error.what());
		} catch (...) {
			SetError("Unknown native archive open failure");
		}
	}

	void OnOK() override
	{
		try {
			const auto handle = RegisterArchive(std::move(archive_));
			deferred_.Resolve(Napi::BigInt::New(Env(), handle));
		} catch (const std::exception& error) {
			deferred_.Reject(Napi::Error::New(Env(), error.what()).Value());
		}
	}

private:
	std::string path_;
	std::optional<std::string> password_;
	std::string enginePath_;
	std::uint32_t deflateBufferSize_;
	std::shared_ptr<ArchiveEngine> archive_;
};

class EntriesWorker final : public BoundedAsyncWorker {
public:
	EntriesWorker(
		Napi::Env env,
		Napi::Promise::Deferred deferred,
		std::shared_ptr<ArchiveEngine> archive)
		: BoundedAsyncWorker(env, deferred), archive_(std::move(archive)) {}

	void Execute() override
	{
		entries_ = archive_->Entries();
	}

	void OnOK() override
	{
		Napi::Array result = Napi::Array::New(Env(), entries_.size());
		for (std::size_t i = 0; i < entries_.size(); ++i) {
			result.Set(i, EntryToJs(Env(), entries_[i]));
		}
		deferred_.Resolve(result);
	}

private:
	std::shared_ptr<ArchiveEngine> archive_;
	std::vector<Entry> entries_;
};

class ExtractionTask {
public:
	virtual ~ExtractionTask() = default;
	virtual void Execute() noexcept = 0;
	virtual void Complete(Napi::Env env) = 0;
};

class ExtractWorker final : public ExtractionTask {
public:
	ExtractWorker(
		Napi::Promise::Deferred deferred,
		std::shared_ptr<ArchiveEngine> archive,
		std::vector<std::uint32_t> ids,
		std::vector<ReadRange> ranges,
		bool singleOutput)
		: deferred_(deferred),
			archive_(std::move(archive)),
			ids_(std::move(ids)),
			ranges_(std::move(ranges)),
			singleOutput_(singleOutput),
			profileEnabled_(std::getenv("ZIP_NATIVE_PROFILE_READ") != nullptr) {}

	~ExtractWorker() override
	{
		g_pendingOperations.fetch_sub(1, std::memory_order_acq_rel);
	}

	void Execute() noexcept override
	{
		std::chrono::steady_clock::time_point started;
		if (profileEnabled_) {
			started = std::chrono::steady_clock::now();
		}
		try {
			outputs_ = archive_->Extract(
				ids_,
				ranges_,
				outputReservation_,
				profileEnabled_ ? &profile_ : nullptr);
		} catch (const std::exception& error) {
			error_ = error.what();
		} catch (...) {
			error_ = "Unknown native extraction failure";
		}
		if (profileEnabled_) {
			executionMs_ = std::chrono::duration<double, std::milli>(
				std::chrono::steady_clock::now() - started).count();
		}
	}

	void Complete(Napi::Env env) override
	{
		if (profileEnabled_) {
			std::fprintf(
				stderr,
				"[7zip-native profile] worker=%.3f ms, validation=%.3f, reservation=%.3f, "
				"requestSetup=%.3f, contextAcquire=%.3f, solidCheck=%.3f, callbackSetup=%.3f, "
				"sevenZipExtract=%.3f (%u calls; perItem=%d; callMin=%.3f; callMax=%.3f), "
				"resultProcessing=%.3f, entries=%zu\n",
				executionMs_,
				profile_.validationMs,
				profile_.reservationMs,
				profile_.requestSetupMs,
				profile_.contextAcquireMs,
				profile_.solidCheckMs,
				profile_.callbackSetupMs,
				profile_.sevenZipExtractMs,
				profile_.sevenZipCalls,
				profile_.abortPerItem,
				profile_.minSevenZipCallMs,
				profile_.maxSevenZipCallMs,
				profile_.resultProcessingMs,
				ids_.size());
			std::fflush(stderr);
		}
		try {
			if (!error_.empty()) {
				deferred_.Reject(Napi::Error::New(env, error_).Value());
				return;
			}
			if (singleOutput_) {
				deferred_.Resolve(TakeBuffer(env, std::move(outputs_.front())));
				return;
			}
			Napi::Array result = Napi::Array::New(env, outputs_.size());
			for (std::size_t i = 0; i < outputs_.size(); ++i) {
				result.Set(i, TakeBuffer(env, std::move(outputs_[i])));
			}
			deferred_.Resolve(result);
		} catch (const Napi::Error& error) {
			deferred_.Reject(error.Value());
		} catch (const std::exception& error) {
			deferred_.Reject(Napi::Error::New(env, error.what()).Value());
		}
	}

private:
	Napi::Promise::Deferred deferred_;
	OutputReservation outputReservation_;
	std::shared_ptr<ArchiveEngine> archive_;
	std::vector<std::uint32_t> ids_;
	std::vector<ReadRange> ranges_;
	bool singleOutput_;
	bool profileEnabled_;
	double executionMs_ = 0;
	ExtractionProfile profile_;
	std::vector<std::vector<std::uint8_t>> outputs_;
	std::string error_;
};

class CreateArchiveWorker final : public ExtractionTask {
public:
	CreateArchiveWorker(
		Napi::Promise::Deferred deferred,
		std::string outputPath,
		std::string format,
		std::vector<ArchiveCreateItem> items,
		std::uint32_t compressionLevel,
		std::string enginePath)
		: deferred_(deferred),
			outputPath_(std::move(outputPath)),
			format_(std::move(format)),
			items_(std::move(items)),
			compressionLevel_(compressionLevel),
			enginePath_(std::move(enginePath)) {}

	~CreateArchiveWorker() override
	{
		g_pendingOperations.fetch_sub(1, std::memory_order_acq_rel);
	}

	void Execute() noexcept override
	{
		try {
			CreateArchiveWith7Zip(
				outputPath_,
				format_,
				items_,
				compressionLevel_,
				enginePath_);
		} catch (const std::exception& error) {
			error_ = error.what();
		} catch (...) {
			error_ = "Unknown native archive creation failure";
		}
	}

	void Complete(Napi::Env env) override
	{
		if (!error_.empty()) {
			deferred_.Reject(Napi::Error::New(env, error_).Value());
			return;
		}
		deferred_.Resolve(env.Undefined());
	}

private:
	Napi::Promise::Deferred deferred_;
	std::string outputPath_;
	std::string format_;
	std::vector<ArchiveCreateItem> items_;
	std::uint32_t compressionLevel_;
	std::string enginePath_;
	std::string error_;
};

class StreamWorker final : public ExtractionTask {
public:
	StreamWorker(
		std::shared_ptr<ArchiveEngine> archive,
		std::uint32_t entryId,
		std::shared_ptr<NativeStreamState> stream)
		: archive_(std::move(archive)),
			entryId_(entryId),
			stream_(std::move(stream)) {}

	~StreamWorker() override
	{
		if (!completed_) {
			stream_->Cancel();
			RemoveStream(stream_->id);
			stream_->ReleaseCallback();
		}
		g_pendingOperations.fetch_sub(1, std::memory_order_acq_rel);
	}

	void Execute() noexcept override
	{
		try {
			archive_->ExtractStream(entryId_, stream_);
			if (!stream_->IsCancelled()) {
				SendMessage(StreamMessage::Kind::End, {});
			}
		} catch (const std::exception& error) {
			if (!stream_->IsCancelled()) {
				SendMessage(StreamMessage::Kind::Error, error.what());
			}
		} catch (...) {
			if (!stream_->IsCancelled()) {
				SendMessage(StreamMessage::Kind::Error, "Unknown native archive streaming failure");
			}
		}
	}

	void Complete(Napi::Env) override
	{
		completed_ = true;
		RemoveStream(stream_->id);
		stream_->ReleaseCallback();
	}

private:
	void SendMessage(StreamMessage::Kind kind, const std::string& error) noexcept
	{
		try {
			auto message = std::make_unique<StreamMessage>();
			message->kind = kind;
			message->error = error;
			stream_->Send(std::move(message));
		} catch (...) {
			stream_->Cancel();
		}
	}

	std::shared_ptr<ArchiveEngine> archive_;
	std::uint32_t entryId_;
	std::shared_ptr<NativeStreamState> stream_;
	bool completed_ = false;
};

class ExtractToFilesWorker final : public ExtractionTask {
public:
	ExtractToFilesWorker(
		Napi::Promise::Deferred deferred,
		std::shared_ptr<ArchiveEngine> archive,
		std::vector<NativeFileOutputSpec> outputs,
		std::shared_ptr<NativeFileTaskState> task)
		: deferred_(deferred),
			archive_(std::move(archive)),
			outputs_(std::move(outputs)),
			task_(std::move(task)) {}

	~ExtractToFilesWorker() override
	{
		RemoveFileTask(task_->id);
		task_->ReleaseCallback();
		g_pendingOperations.fetch_sub(1, std::memory_order_acq_rel);
	}

	void Execute() noexcept override
	{
		AsyncFileWriter writer(task_);
		try {
			writer.Start();
			archive_->ExtractToFiles(outputs_, task_, writer);
		} catch (const std::exception& error) {
			error_ = error.what();
		} catch (...) {
			error_ = "Unknown native file extraction failure";
		}
		writer.StopAndJoin();
		if (error_.empty()) {
			error_ = task_->Failure();
			if (error_.empty() && task_->IsCancelled()) {
				error_ = "Native folder extraction was cancelled";
			}
		}
		if (!task_->WaitForFileCompletions() && error_.empty()) {
			error_ = "Unable to deliver native file completion events";
		}
	}

	void Complete(Napi::Env env) override
	{
		if (!error_.empty()) {
			deferred_.Reject(Napi::Error::New(env, error_).Value());
			return;
		}
		deferred_.Resolve(env.Undefined());
	}

private:
	Napi::Promise::Deferred deferred_;
	std::shared_ptr<ArchiveEngine> archive_;
	std::vector<NativeFileOutputSpec> outputs_;
	std::shared_ptr<NativeFileTaskState> task_;
	std::string error_;
};

class ExtractionPool {
public:
	void Initialize(Napi::Env env)
	{
		const auto callback = Napi::Function::New(env, [](const Napi::CallbackInfo& info) {
			return info.Env().Undefined();
		});
		completion_ = Napi::ThreadSafeFunction::New(
			env, callback, "7zip-native extraction completion", 0, 1);
		completion_.Unref(env);
		if (napi_add_env_cleanup_hook(env, Cleanup, this) != napi_ok) {
			completion_.Release();
			throw std::runtime_error("Unable to register native extraction pool cleanup");
		}
		initialized_ = true;
	}

	~ExtractionPool()
	{
		Shutdown();
	}

	void SetConcurrency(std::uint32_t concurrency)
	{
		if (concurrency == 0 || concurrency > kMaxExtractionConcurrency) {
			throw std::out_of_range("Concurrency must be between 1 and 128");
		}
		std::lock_guard<std::mutex> lock(mutex_);
		if (stopping_) {
			throw std::runtime_error("Native extraction pool is shutting down");
		}
		for (std::size_t i = threads_.size(); i < concurrency; ++i) {
			threads_.emplace_back([this]() {
				WorkerLoop();
			});
		}
		concurrency_ = concurrency;
		g_extractionConcurrency.store(concurrency, std::memory_order_release);
		available_.notify_all();
	}

	std::uint32_t Concurrency() const
	{
		return g_extractionConcurrency.load(std::memory_order_acquire);
	}

	void Queue(Napi::Env env, ExtractionTask *task)
	{
		std::lock_guard<std::mutex> lock(mutex_);
		if (stopping_ || concurrency_ == 0) {
			throw std::runtime_error("Native extraction pool is not available");
		}
		const bool wasIdle = pending_ == 0;
		if (wasIdle) {
			completion_.Ref(env);
		}
		try {
			tasks_.push_back(task);
		} catch (...) {
			if (wasIdle) {
				completion_.Unref(env);
			}
			throw;
		}
		++pending_;
		available_.notify_one();
	}

	void Finished(Napi::Env env)
	{
		std::lock_guard<std::mutex> lock(mutex_);
		if (pending_ > 0 && --pending_ == 0) {
			completion_.Unref(env);
		}
	}

private:
	static void Cleanup(void *data)
	{
		auto *pool = static_cast<ExtractionPool *>(data);
		pool->Shutdown();
		if (g_extractionPool == pool) {
			g_extractionPool = nullptr;
		}
		delete pool;
	}

	void Shutdown()
	{
		{
			std::lock_guard<std::mutex> lock(mutex_);
			if (stopping_) {
				return;
			}
			stopping_ = true;
		}
		available_.notify_all();
		for (auto& thread : threads_) {
			if (thread.joinable()) {
				thread.join();
			}
		}
		threads_.clear();
		if (initialized_) {
			completion_.Release();
			initialized_ = false;
		}
	}

	void WorkerLoop()
	{
		while (true) {
			ExtractionTask *task = nullptr;
			{
				std::unique_lock<std::mutex> lock(mutex_);
				available_.wait(lock, [this]() {
					return (stopping_ && tasks_.empty())
						|| (!tasks_.empty() && activeWorkers_ < concurrency_);
				});
				if (stopping_ && tasks_.empty()) {
					return;
				}
				task = tasks_.front();
				tasks_.pop_front();
				++activeWorkers_;
			}
			task->Execute();
			const auto status = completion_.NonBlockingCall(
				task,
				[](Napi::Env env, Napi::Function, ExtractionTask *completed) {
					std::unique_ptr<ExtractionTask> task(completed);
					task->Complete(env);
					if (g_extractionPool != nullptr) {
						g_extractionPool->Finished(env);
					}
				});
			if (status != napi_ok) {
				delete task;
				std::lock_guard<std::mutex> lock(mutex_);
				if (pending_ > 0) {
					--pending_;
				}
			}
			{
				std::lock_guard<std::mutex> lock(mutex_);
				--activeWorkers_;
			}
			available_.notify_one();
		}
	}

	Napi::ThreadSafeFunction completion_;
	std::vector<std::thread> threads_;
	std::deque<ExtractionTask *> tasks_;
	std::mutex mutex_;
	std::condition_variable available_;
	std::uint32_t concurrency_ = 0;
	std::size_t activeWorkers_ = 0;
	std::size_t pending_ = 0;
	bool stopping_ = false;
	bool initialized_ = false;
};

Napi::Value Open(const Napi::CallbackInfo& info)
{
	const auto env = info.Env();
	if (info.Length() != 4 || !info[0].IsString()
		|| (!info[1].IsUndefined() && !info[1].IsString())
		|| !info[2].IsString() || !info[3].IsNumber()) {
		throw Napi::TypeError::New(
			env, "open(path, password?, enginePath, deflateBufferSize) expects a path, optional password, engine path, and buffer size");
	}
	const double deflateBufferSizeValue = info[3].As<Napi::Number>().DoubleValue();
	if (!std::isfinite(deflateBufferSizeValue)
		|| std::floor(deflateBufferSizeValue) != deflateBufferSizeValue
		|| deflateBufferSizeValue < kMinDeflateBufferSize
		|| deflateBufferSizeValue > kMaxDeflateBufferSize) {
		throw Napi::RangeError::New(
			env, "Deflate buffer size must be an integer between 4096 and 2097152 bytes");
	}
	std::optional<std::string> password;
	if (info[1].IsString()) {
		password = info[1].As<Napi::String>().Utf8Value();
		if (password->size() > kMaxPasswordBytes) {
			throw Napi::RangeError::New(env, "Password exceeds the 1 MiB native password limit");
		}
	}
	if (!ReserveOperation()) {
		throw Napi::Error::New(env, "Native operation queue is full");
	}
	Napi::Promise::Deferred deferred = Napi::Promise::Deferred::New(env);
	auto *worker = new OpenWorker(
		env,
		deferred,
		info[0].As<Napi::String>().Utf8Value(),
		std::move(password),
		info[2].As<Napi::String>().Utf8Value(),
		static_cast<std::uint32_t>(deflateBufferSizeValue));
	worker->Queue();
	return deferred.Promise();
}

Napi::Value CreateArchive(const Napi::CallbackInfo& info)
{
	const auto env = info.Env();
	if (info.Length() != 5 || !info[0].IsString() || !info[1].IsString()
		|| !info[2].IsArray() || !info[3].IsNumber() || !info[4].IsString()) {
		throw Napi::TypeError::New(
			env, "create(outputPath, format, entries, compressionLevel, enginePath) expects valid arguments");
	}
	const auto format = info[1].As<Napi::String>().Utf8Value();
	if (format != "7z" && format != "zip" && format != "tar" && format != "wim") {
		throw Napi::TypeError::New(env, "Archive format must be 7z, zip, tar, or wim");
	}
	const double levelValue = info[3].As<Napi::Number>().DoubleValue();
	if (!std::isfinite(levelValue) || std::floor(levelValue) != levelValue
		|| levelValue < 0 || levelValue > 9) {
		throw Napi::RangeError::New(env, "Compression level must be an integer between 0 and 9");
	}
	const auto inputEntries = info[2].As<Napi::Array>();
	if (inputEntries.Length() > kMaxEntries) {
		throw Napi::RangeError::New(env, "Archive creation exceeds the native entry limit");
	}
	std::vector<ArchiveCreateItem> entries;
	entries.reserve(inputEntries.Length());
	for (std::uint32_t i = 0; i < inputEntries.Length(); ++i) {
		const auto value = inputEntries.Get(i);
		if (!value.IsObject() || value.IsNull()) {
			throw Napi::TypeError::New(env, "Archive creation entries must be objects");
		}
		const auto item = value.As<Napi::Object>();
		const auto sourcePath = item.Get("sourcePath");
		const auto archivePath = item.Get("path");
		const auto mtimeMs = item.Get("mtimeMs");
		if (!sourcePath.IsString() || !archivePath.IsString() || !mtimeMs.IsNumber()) {
			throw Napi::TypeError::New(
				env, "Archive creation entries require string sourcePath, path, and numeric mtimeMs values");
		}
		const double sourceMtimeMs = mtimeMs.As<Napi::Number>().DoubleValue();
		if (!std::isfinite(sourceMtimeMs)) {
			throw Napi::TypeError::New(env, "Archive creation entry mtimeMs must be finite");
		}
		entries.push_back({
			sourcePath.As<Napi::String>().Utf8Value(),
			archivePath.As<Napi::String>().Utf8Value(),
			sourceMtimeMs,
		});
	}
	if (!ReserveOperation()) {
		throw Napi::Error::New(env, "Native operation queue is full");
	}
	auto deferred = Napi::Promise::Deferred::New(env);
	CreateArchiveWorker *worker = nullptr;
	try {
		if (g_extractionPool == nullptr) {
			throw std::runtime_error("Native extraction pool is not initialized");
		}
		worker = new CreateArchiveWorker(
			deferred,
			info[0].As<Napi::String>().Utf8Value(),
			format,
			std::move(entries),
			static_cast<std::uint32_t>(levelValue),
			info[4].As<Napi::String>().Utf8Value());
		g_extractionPool->Queue(env, worker);
	} catch (const std::exception& error) {
		if (worker != nullptr) {
			delete worker;
		} else {
			g_pendingOperations.fetch_sub(1, std::memory_order_acq_rel);
		}
		throw Napi::Error::New(env, error.what());
	} catch (...) {
		if (worker != nullptr) {
			delete worker;
		} else {
			g_pendingOperations.fetch_sub(1, std::memory_order_acq_rel);
		}
		throw Napi::Error::New(env, "Unable to queue native archive creation");
	}
	return deferred.Promise();
}

Napi::Value Entries(const Napi::CallbackInfo& info)
{
	const auto env = info.Env();
	if (info.Length() != 1) {
		throw Napi::TypeError::New(env, "entries(handle) expects an archive handle");
	}
	const auto handle = GetHandle(info[0]);
	auto archive = FindArchive(handle);
	if (!archive) {
		throw Napi::Error::New(env, "Archive is closed");
	}
	if (!ReserveOperation()) {
		throw Napi::Error::New(env, "Native operation queue is full");
	}
	auto deferred = Napi::Promise::Deferred::New(env);
	(new EntriesWorker(env, deferred, std::move(archive)))->Queue();
	return deferred.Promise();
}

Napi::Value QueueExtraction(
	Napi::Env env,
	Napi::Promise::Deferred deferred,
	std::shared_ptr<ArchiveEngine> archive,
	std::vector<std::uint32_t> ids,
	std::vector<ReadRange> ranges,
	bool singleOutput)
{
	if (!ReserveOperation()) {
		throw Napi::Error::New(env, "Native operation queue is full");
	}
	ExtractWorker *worker = nullptr;
	try {
		if (g_extractionPool == nullptr) {
			throw std::runtime_error("Native extraction pool is not initialized");
		}
		worker = new ExtractWorker(
			deferred, std::move(archive), std::move(ids), std::move(ranges), singleOutput);
		g_extractionPool->Queue(env, worker);
	} catch (const std::exception& error) {
		if (worker != nullptr) {
			delete worker;
		} else {
			g_pendingOperations.fetch_sub(1, std::memory_order_acq_rel);
		}
		throw Napi::Error::New(env, error.what());
	} catch (...) {
		if (worker != nullptr) {
			delete worker;
		} else {
			g_pendingOperations.fetch_sub(1, std::memory_order_acq_rel);
		}
		throw Napi::Error::New(env, "Unable to queue native extraction");
	}
	return deferred.Promise();
}

Napi::Value Extract(const Napi::CallbackInfo& info)
{
	const auto env = info.Env();
	if (info.Length() != 2 || !info[1].IsArray()) {
		throw Napi::TypeError::New(env, "extract(handle, ids) expects an array of entry IDs");
	}
	const auto handle = GetHandle(info[0]);
	auto archive = FindArchive(handle);
	if (!archive) {
		throw Napi::Error::New(env, "Archive is closed");
	}
	std::vector<std::uint32_t> ids;
	const auto inputIds = info[1].As<Napi::Array>();
	ids.reserve(inputIds.Length());
	for (std::uint32_t i = 0; i < inputIds.Length(); ++i) {
		std::uint64_t id = 0;
		if (!ReadUnsigned(inputIds.Get(i), id) || id > std::numeric_limits<std::uint32_t>::max()) {
			throw Napi::TypeError::New(env, "Entry IDs must be non-negative 32-bit integers");
		}
		ids.push_back(static_cast<std::uint32_t>(id));
	}
	auto deferred = Napi::Promise::Deferred::New(env);
	return QueueExtraction(
		env, deferred, std::move(archive), std::move(ids), {}, false);
}

Napi::Value StartStream(const Napi::CallbackInfo& info)
{
	const auto env = info.Env();
	if (info.Length() != 3 || !info[2].IsFunction()) {
		throw Napi::TypeError::New(
			env, "startStream(handle, id, callback) expects an archive handle, entry ID, and callback");
	}
	const auto handle = GetHandle(info[0]);
	auto archive = FindArchive(handle);
	if (!archive) {
		throw Napi::Error::New(env, "Archive is closed");
	}
	std::uint64_t entryId = 0;
	if (!ReadUnsigned(info[1], entryId) || entryId > std::numeric_limits<std::uint32_t>::max()) {
		throw Napi::TypeError::New(env, "Entry ID must be a non-negative 32-bit integer");
	}
	if (g_extractionPool == nullptr) {
		throw Napi::Error::New(env, "Native extraction pool is not initialized");
	}
	if (!ReserveOperation()) {
		throw Napi::Error::New(env, "Native operation queue is full");
	}

	std::shared_ptr<NativeStreamState> stream;
	StreamWorker *worker = nullptr;
	std::uint64_t streamId = 0;
	bool callbackCreated = false;
	try {
		stream = std::make_shared<NativeStreamState>();
		stream->callback = Napi::ThreadSafeFunction::New(
			env,
			info[2].As<Napi::Function>(),
			"7zip-native archive entry stream",
			1,
			1);
		callbackCreated = true;
		streamId = RegisterStream(stream);
		const auto result = Napi::BigInt::New(env, streamId);
		worker = new StreamWorker(
			std::move(archive),
			static_cast<std::uint32_t>(entryId),
			stream);
		g_extractionPool->Queue(env, worker);
		worker = nullptr;
		return result;
	} catch (...) {
		if (worker != nullptr) {
			delete worker;
		} else {
			if (streamId != 0) {
				RemoveStream(streamId);
			}
			if (stream) {
				stream->Cancel();
				if (callbackCreated) {
					stream->ReleaseCallback();
				}
			}
			g_pendingOperations.fetch_sub(1, std::memory_order_acq_rel);
		}
		throw;
	}
}

Napi::Value StartExtractToFiles(const Napi::CallbackInfo& info)
{
	const auto env = info.Env();
	if (info.Length() < 2
		|| info.Length() > 3
		|| !info[1].IsArray()
		|| (info.Length() == 3 && !info[2].IsUndefined() && !info[2].IsFunction())) {
		throw Napi::TypeError::New(
			env, "startExtractToFiles(handle, files, fileCompleteCallback?) expects a handle, file list, and an optional file-completion callback");
	}
	const auto handle = GetHandle(info[0]);
	auto archive = FindArchive(handle);
	if (!archive) {
		throw Napi::Error::New(env, "Archive is closed");
	}
	const auto inputFiles = info[1].As<Napi::Array>();
	if (inputFiles.Length() > kMaxEntries) {
		throw Napi::RangeError::New(env, "Folder extraction batch exceeds the native entry limit");
	}
	std::vector<NativeFileOutputSpec> outputs;
	outputs.reserve(inputFiles.Length());
	for (std::uint32_t index = 0; index < inputFiles.Length(); ++index) {
		const auto value = inputFiles.Get(index);
		if (!value.IsObject() || value.IsNull()) {
			throw Napi::TypeError::New(env, "Folder extraction files must be objects");
		}
		const auto file = value.As<Napi::Object>();
		std::uint64_t id = 0;
		const auto path = file.Get("path");
		const auto overwrite = file.Get("overwrite");
		if (!ReadUnsigned(file.Get("id"), id)
			|| id > std::numeric_limits<std::uint32_t>::max()
			|| !path.IsString()
			|| !overwrite.IsBoolean()) {
			throw Napi::TypeError::New(
				env, "Folder extraction files require a valid entry ID, output path, and overwrite flag");
		}
		outputs.push_back({
			static_cast<std::uint32_t>(id),
			path.As<Napi::String>().Utf8Value(),
			overwrite.As<Napi::Boolean>().Value(),
		});
	}
	if (g_extractionPool == nullptr) {
		throw Napi::Error::New(env, "Native extraction pool is not initialized");
	}
	if (!ReserveOperation()) {
		throw Napi::Error::New(env, "Native operation queue is full");
	}

	std::shared_ptr<NativeFileTaskState> task;
	ExtractToFilesWorker *worker = nullptr;
	std::uint64_t taskId = 0;
	try {
		task = std::make_shared<NativeFileTaskState>();
		if (info.Length() == 3 && info[2].IsFunction()) {
			task->fileCompletionCallback = Napi::ThreadSafeFunction::New(
				env,
				info[2].As<Napi::Function>(),
				"7zip-native folder file completion",
				1,
				1);
			task->hasFileCompletionCallback_ = true;
		}
		taskId = RegisterFileTask(task);
		auto deferred = Napi::Promise::Deferred::New(env);
		auto result = Napi::Object::New(env);
		result.Set("taskId", Napi::BigInt::New(env, taskId));
		result.Set("promise", deferred.Promise());
		worker = new ExtractToFilesWorker(
			deferred,
			std::move(archive),
			std::move(outputs),
			task);
		g_extractionPool->Queue(env, worker);
		worker = nullptr;
		return result;
	} catch (const std::exception& error) {
		if (worker != nullptr) {
			delete worker;
		} else {
			if (taskId != 0) {
				RemoveFileTask(taskId);
			}
			if (task) {
				task->Cancel();
				task->ReleaseCallback();
			}
			g_pendingOperations.fetch_sub(1, std::memory_order_acq_rel);
		}
		throw Napi::Error::New(env, error.what());
	} catch (...) {
		if (worker != nullptr) {
			delete worker;
		} else {
			if (taskId != 0) {
				RemoveFileTask(taskId);
			}
			if (task) {
				task->Cancel();
				task->ReleaseCallback();
			}
			g_pendingOperations.fetch_sub(1, std::memory_order_acq_rel);
		}
		throw Napi::Error::New(env, "Unable to queue native folder extraction");
	}
}

Napi::Value CancelExtractToFiles(const Napi::CallbackInfo& info)
{
	const auto env = info.Env();
	std::uint64_t taskId = 0;
	if (info.Length() != 1 || !ReadUnsigned(info[0], taskId) || taskId == 0) {
		throw Napi::TypeError::New(
			env, "cancelExtractToFiles(taskId) expects a positive task ID");
	}
	if (const auto task = FindFileTask(taskId)) {
		task->Cancel();
	}
	return env.Undefined();
}

Napi::Value ResumeStream(const Napi::CallbackInfo& info)
{
	const auto env = info.Env();
	std::uint64_t streamId = 0;
	if (info.Length() != 1 || !ReadUnsigned(info[0], streamId) || streamId == 0) {
		throw Napi::TypeError::New(env, "resumeStream(streamId) expects a positive stream ID");
	}
	if (const auto stream = FindStream(streamId)) {
		stream->Resume();
	}
	return env.Undefined();
}

Napi::Value CancelStream(const Napi::CallbackInfo& info)
{
	const auto env = info.Env();
	std::uint64_t streamId = 0;
	if (info.Length() != 1 || !ReadUnsigned(info[0], streamId) || streamId == 0) {
		throw Napi::TypeError::New(env, "cancelStream(streamId) expects a positive stream ID");
	}
	if (const auto stream = FindStream(streamId)) {
		stream->Cancel();
	}
	return env.Undefined();
}

Napi::Value Read(const Napi::CallbackInfo& info)
{
	const auto env = info.Env();
	if (info.Length() != 4) {
		throw Napi::TypeError::New(env, "read(handle, id, offset, length) expects four arguments");
	}
	const auto handle = GetHandle(info[0]);
	auto archive = FindArchive(handle);
	if (!archive) {
		throw Napi::Error::New(env, "Archive is closed");
	}
	std::uint64_t id = 0;
	std::uint64_t offset = 0;
	std::uint64_t length = 0;
	if (!ReadUnsigned(info[1], id) || id > std::numeric_limits<std::uint32_t>::max()
		|| !ReadUnsigned(info[2], offset) || !ReadUnsigned(info[3], length)) {
		throw Napi::TypeError::New(env, "Entry ID, offset, and length must be non-negative safe integers or bigints");
	}
	if (length > kMaxReadBytes || offset > std::numeric_limits<std::uint64_t>::max() - length) {
		throw Napi::RangeError::New(env, "Requested range exceeds the native read limit");
	}
	auto deferred = Napi::Promise::Deferred::New(env);
	return QueueExtraction(
		env,
		deferred,
		std::move(archive),
		{static_cast<std::uint32_t>(id)},
		{{offset, length}},
		true);
}

Napi::Value ReadMany(const Napi::CallbackInfo& info)
{
	const auto env = info.Env();
	if (info.Length() != 2 || !info[1].IsArray()) {
		throw Napi::TypeError::New(env, "readMany(handle, requests) expects an array of read requests");
	}
	const auto handle = GetHandle(info[0]);
	auto archive = FindArchive(handle);
	if (!archive) {
		throw Napi::Error::New(env, "Archive is closed");
	}
	const auto inputRequests = info[1].As<Napi::Array>();
	if (inputRequests.Length() > kMaxEntries) {
		throw Napi::RangeError::New(env, "Batch read exceeds the native entry limit");
	}
	std::vector<std::uint32_t> ids;
	std::vector<ReadRange> ranges;
	ids.reserve(inputRequests.Length());
	ranges.reserve(inputRequests.Length());
	for (std::uint32_t i = 0; i < inputRequests.Length(); ++i) {
		const auto value = inputRequests.Get(i);
		if (!value.IsObject() || value.IsNull()) {
			throw Napi::TypeError::New(env, "Batch read requests must be objects");
		}
		const auto request = value.As<Napi::Object>();
		std::uint64_t id = 0;
		std::uint64_t offset = 0;
		std::uint64_t length = 0;
		if (!ReadUnsigned(request.Get("id"), id) || id > std::numeric_limits<std::uint32_t>::max()
			|| !ReadUnsigned(request.Get("offset"), offset) || !ReadUnsigned(request.Get("length"), length)) {
			throw Napi::TypeError::New(
				env, "Batch read requests require a valid entry ID, offset, and length");
		}
		if (length > kMaxReadBytes || offset > std::numeric_limits<std::uint64_t>::max() - length) {
			throw Napi::RangeError::New(env, "Requested range exceeds the native read limit");
		}
		ids.push_back(static_cast<std::uint32_t>(id));
		ranges.push_back({offset, length});
	}
	auto deferred = Napi::Promise::Deferred::New(env);
	return QueueExtraction(
		env, deferred, std::move(archive), std::move(ids), std::move(ranges), false);
}

Napi::Value Concurrency(const Napi::CallbackInfo& info)
{
	const auto env = info.Env();
	if (info.Length() > 1) {
		throw Napi::TypeError::New(env, "concurrency() accepts at most one integer");
	}
	if (g_extractionPool == nullptr) {
		throw Napi::Error::New(env, "Native extraction pool is not initialized");
	}
	if (info.Length() == 0) {
		return Napi::Number::New(env, g_extractionPool->Concurrency());
	}
	if (!info[0].IsNumber()) {
		throw Napi::TypeError::New(env, "Concurrency must be a positive integer");
	}
	const double value = info[0].As<Napi::Number>().DoubleValue();
	if (!std::isfinite(value) || std::floor(value) != value
		|| value < 1 || value > kMaxExtractionConcurrency) {
		throw Napi::RangeError::New(env, "Concurrency must be between 1 and 128");
	}
	try {
		g_extractionPool->SetConcurrency(static_cast<std::uint32_t>(value));
	} catch (const std::exception& error) {
		throw Napi::Error::New(env, error.what());
	}
	return Napi::Number::New(env, value);
}

Napi::Value Close(const Napi::CallbackInfo& info)
{
	const auto env = info.Env();
	if (info.Length() != 1) {
		throw Napi::TypeError::New(env, "close(handle) expects an archive handle");
	}
	const auto handle = GetHandle(info[0]);
	{
		std::lock_guard<std::mutex> lock(g_handlesMutex);
		if (g_handles.erase(handle) == 0) {
			throw Napi::Error::New(env, "Archive is already closed");
		}
	}
	return env.Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports)
{
	if (g_extractionPool != nullptr) {
		throw Napi::Error::New(env, "The native extraction pool is already initialized");
	}
	g_extractionPool = new ExtractionPool();
	try {
		g_extractionPool->Initialize(env);
	} catch (...) {
		delete g_extractionPool;
		g_extractionPool = nullptr;
		throw;
	}
	exports.Set("open", Napi::Function::New(env, Open));
	exports.Set("create", Napi::Function::New(env, CreateArchive));
	exports.Set("entries", Napi::Function::New(env, Entries));
	exports.Set("extract", Napi::Function::New(env, Extract));
	exports.Set("readMany", Napi::Function::New(env, ReadMany));
	exports.Set("startStream", Napi::Function::New(env, StartStream));
	exports.Set("startExtractToFiles", Napi::Function::New(env, StartExtractToFiles));
	exports.Set("cancelExtractToFiles", Napi::Function::New(env, CancelExtractToFiles));
	exports.Set("resumeStream", Napi::Function::New(env, ResumeStream));
	exports.Set("cancelStream", Napi::Function::New(env, CancelStream));
	exports.Set("read", Napi::Function::New(env, Read));
	exports.Set("concurrency", Napi::Function::New(env, Concurrency));
	exports.Set("close", Napi::Function::New(env, Close));
	return exports;
}

} // namespace

NODE_API_MODULE(7zip_native, Init)
