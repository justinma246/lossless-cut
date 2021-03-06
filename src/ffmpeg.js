const execa = require('execa');
const pMap = require('p-map');
const { join, extname } = require('path');
const fileType = require('file-type');
const readChunk = require('read-chunk');
const flatMap = require('lodash/flatMap');
const flatMapDeep = require('lodash/flatMapDeep');
const sum = require('lodash/sum');
const sortBy = require('lodash/sortBy');
const readline = require('readline');
const moment = require('moment');
const stringToStream = require('string-to-stream');
const trash = require('trash');
const isDev = require('electron-is-dev');
const os = require('os');

const { formatDuration, getOutPath, transferTimestamps } = require('./util');


function getFfCommandLine(cmd, args) {
  const mapArg = arg => (/[^0-9a-zA-Z-_]/.test(arg) ? `'${arg}'` : arg);
  return `${cmd} ${args.map(mapArg).join(' ')}`;
}

function getPath(type) {
  const platform = os.platform();

  const map = {
    darwin: `darwin/x64/${type}`,
    win32: `win32/x64/${type}.exe`,
    linux: `linux/x64/${type}`,
  };

  const subPath = map[platform];

  if (!subPath) throw new Error(`Unsupported platform ${platform}`);

  return isDev
    ? `node_modules/${type}-static/bin/${subPath}`
    : join(window.process.resourcesPath, `node_modules/${type}-static/bin/${subPath}`);
}

async function runFfprobe(args) {
  const ffprobePath = await getPath('ffprobe');
  console.log(getFfCommandLine('ffprobe', args));
  return execa(ffprobePath, args);
}

async function runFfmpeg(args) {
  const ffmpegPath = await getPath('ffmpeg');
  console.log(getFfCommandLine('ffmpeg', args));
  return execa(ffmpegPath, args);
}


function handleProgress(process, cutDuration, onProgress) {
  const rl = readline.createInterface({ input: process.stderr });
  rl.on('line', (line) => {
    try {
      const match = line.match(/frame=\s*[^\s]+\s+fps=\s*[^\s]+\s+q=\s*[^\s]+\s+(?:size|Lsize)=\s*[^\s]+\s+time=\s*([^\s]+)\s+/); // eslint-disable-line max-len
      if (!match) return;

      const str = match[1];
      console.log(str);
      const progressTime = moment.duration(str).asSeconds();
      console.log(progressTime);
      onProgress(progressTime / cutDuration);
    } catch (err) {
      console.log('Failed to parse ffmpeg progress line', err);
    }
  });
}

function isCuttingStart(cutFrom) {
  return cutFrom > 0;
}

function isCuttingEnd(cutTo, duration) {
  return cutTo < duration;
}

function getExtensionForFormat(format) {
  const ext = {
    matroska: 'mkv',
    ipod: 'm4a',
  }[format];

  return ext || format;
}

async function readFrames({ filePath, aroundTime, window = 30, stream }) {
  const intervalsArgs = aroundTime != null ? ['-read_intervals', `${Math.max(aroundTime - window, 0)}%${aroundTime + window}`] : [];
  const { stdout } = await runFfprobe(['-v', 'error', ...intervalsArgs, '-show_packets', '-select_streams', stream, '-show_entries', 'packet=pts_time,flags', '-of', 'json', filePath]);
  return sortBy(JSON.parse(stdout).packets.map(p => ({ keyframe: p.flags[0] === 'K', time: parseFloat(p.pts_time, 10) })), 'time');
}

// https://stackoverflow.com/questions/14005110/how-to-split-a-video-using-ffmpeg-so-that-each-chunk-starts-with-a-key-frame
// http://kicherer.org/joomla/index.php/de/blog/42-avcut-frame-accurate-video-cutting-with-only-small-quality-loss
function getNextPrevKeyframe(frames, cutTime, nextMode) {
  const sigma = 0.01;
  const isCloseTo = (time1, time2) => Math.abs(time1 - time2) < sigma;

  let index;

  if (frames.length < 2) throw new Error('Less than 2 frames found');

  if (nextMode) {
    index = frames.findIndex(f => f.keyframe && f.time >= cutTime - sigma);
    if (index === -1) throw new Error('Failed to find next keyframe');
    if (index >= frames.length - 1) throw new Error('We are on the last frame');
    const { time } = frames[index];
    if (isCloseTo(time, cutTime)) {
      return undefined; // Already on keyframe, no need to modify cut time
    }
    return time;
  }

  const findReverseIndex = (arr, cb) => {
    const ret = [...arr].reverse().findIndex(cb);
    if (ret === -1) return -1;
    return arr.length - 1 - ret;
  };

  index = findReverseIndex(frames, f => f.time <= cutTime + sigma);
  if (index === -1) throw new Error('Failed to find any prev frame');
  if (index === 0) throw new Error('We are on the first frame');

  if (index === frames.length - 1) {
    // Last frame of video, no need to modify cut time
    return undefined;
  }
  if (frames[index + 1].keyframe) {
    // Already on frame before keyframe, no need to modify cut time
    return undefined;
  }

  // We are not on a frame before keyframe, look for preceding keyframe instead
  index = findReverseIndex(frames, f => f.keyframe && f.time <= cutTime + sigma);
  if (index === -1) throw new Error('Failed to find any prev keyframe');
  if (index === 0) throw new Error('We are on the first keyframe');

  // Use frame before the found keyframe
  return frames[index - 1].time;
}

async function cut({
  filePath, outFormat, cutFrom, cutTo, videoDuration, rotation,
  onProgress, copyStreamIds, keyframeCut, outPath, appendFfmpegCommandLog,
}) {
  console.log('Cutting from', cutFrom, 'to', cutTo);

  const ssBeforeInput = keyframeCut;

  const cutDuration = cutTo - cutFrom;

  // Don't cut if no need: https://github.com/mifi/lossless-cut/issues/50
  const cutFromArgs = isCuttingStart(cutFrom) ? ['-ss', cutFrom.toFixed(5)] : [];
  const cutToArgs = isCuttingEnd(cutTo, videoDuration) ? ['-t', cutDuration.toFixed(5)] : [];

  const copyStreamIdsFiltered = copyStreamIds.filter(({ streamIds }) => streamIds.length > 0);

  const inputArgs = flatMap(copyStreamIdsFiltered, ({ path }) => ['-i', path]);
  const inputCutArgs = ssBeforeInput ? [
    ...cutFromArgs,
    ...inputArgs,
    ...cutToArgs,
    '-avoid_negative_ts', 'make_zero',
  ] : [
    ...inputArgs,
    ...cutFromArgs,
    ...cutToArgs,
  ];

  const rotationArgs = rotation !== undefined ? ['-metadata:s:v:0', `rotate=${rotation}`] : [];

  const ffmpegArgs = [
    ...inputCutArgs,

    '-c', 'copy',

    ...flatMapDeep(copyStreamIdsFiltered, ({ streamIds }, fileIndex) => streamIds.map(streamId => ['-map', `${fileIndex}:${streamId}`])),
    '-map_metadata', '0',
    // https://video.stackexchange.com/questions/23741/how-to-prevent-ffmpeg-from-dropping-metadata
    '-movflags', 'use_metadata_tags',

    // See https://github.com/mifi/lossless-cut/issues/170
    '-ignore_unknown',

    ...rotationArgs,

    '-f', outFormat, '-y', outPath,
  ];

  const ffmpegCommandLine = getFfCommandLine('ffmpeg', ffmpegArgs);

  console.log(ffmpegCommandLine);
  appendFfmpegCommandLog(ffmpegCommandLine);

  onProgress(0);

  const ffmpegPath = await getPath('ffmpeg');
  const process = execa(ffmpegPath, ffmpegArgs);
  handleProgress(process, cutDuration, onProgress);
  const result = await process;
  console.log(result.stdout);

  await transferTimestamps(filePath, outPath);
}

async function cutMultiple({
  customOutDir, filePath, segments: segmentsUnsorted, videoDuration, rotation,
  onProgress, keyframeCut, copyStreamIds, outFormat, isOutFormatUserSelected,
  appendFfmpegCommandLog,
}) {
  const segments = sortBy(segmentsUnsorted, 'cutFrom');
  const singleProgresses = {};
  function onSingleProgress(id, singleProgress) {
    singleProgresses[id] = singleProgress;
    return onProgress((sum(Object.values(singleProgresses)) / segments.length));
  }

  const outFiles = [];

  let i = 0;
  // eslint-disable-next-line no-restricted-syntax,no-unused-vars
  for (const { cutFrom, cutTo } of segments) {
    const ext = isOutFormatUserSelected ? `.${getExtensionForFormat(outFormat)}` : extname(filePath);
    const cutSpecification = `${formatDuration({ seconds: cutFrom, fileNameFriendly: true })}-${formatDuration({ seconds: cutTo, fileNameFriendly: true })}`;

    const outPath = getOutPath(customOutDir, filePath, `${cutSpecification}${ext}`);

    // eslint-disable-next-line no-await-in-loop
    await cut({
      outPath,
      customOutDir,
      filePath,
      outFormat,
      videoDuration,
      rotation,
      copyStreamIds,
      keyframeCut,
      cutFrom,
      cutTo,
      // eslint-disable-next-line no-loop-func
      onProgress: progress => onSingleProgress(i, progress),
      appendFfmpegCommandLog,
    });

    outFiles.push(outPath);

    i += 1;
  }

  return outFiles;
}

async function html5ify(filePath, outPath, encodeVideo, encodeAudio) {
  console.log('Making HTML5 friendly version', { filePath, outPath, encodeVideo });

  const videoArgs = encodeVideo
    ? ['-vf', 'scale=-2:400,format=yuv420p', '-sws_flags', 'neighbor', '-vcodec', 'libx264', '-profile:v', 'baseline', '-x264opts', 'level=3.0', '-preset:v', 'ultrafast', '-crf', '28']
    : ['-vcodec', 'copy'];

  const audioArgs = encodeAudio ? ['-acodec', 'aac', '-b:a', '96k'] : ['-an'];

  const ffmpegArgs = [
    '-i', filePath, ...videoArgs, ...audioArgs,
    '-y', outPath,
  ];

  const { stdout } = await runFfmpeg(ffmpegArgs);
  console.log(stdout);

  await transferTimestamps(filePath, outPath);
}

async function getDuration(filePath) {
  // https://superuser.com/questions/650291/how-to-get-video-duration-in-seconds
  const { stdout } = await runFfprobe(['-i', filePath, '-show_entries', 'format=duration', '-print_format', 'json']);
  return parseFloat(JSON.parse(stdout).format.duration);
}

// This is just used to load something into the player with correct length,
// so user can seek and then we render frames using ffmpeg
async function html5ifyDummy(filePath, outPath) {
  console.log('Making HTML5 friendly dummy', { filePath, outPath });

  const duration = await getDuration(filePath);

  const ffmpegArgs = [
    // This is just a fast way of generating an empty dummy file
    // TODO use existing audio track file if it has one
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-t', duration,
    '-acodec', 'flac',
    '-y', outPath,
  ];

  const { stdout } = await runFfmpeg(ffmpegArgs);
  console.log(stdout);

  await transferTimestamps(filePath, outPath);
}

async function mergeFiles({ paths, outPath, allStreams }) {
  console.log('Merging files', { paths }, 'to', outPath);

  // https://blog.yo1.dog/fix-for-ffmpeg-protocol-not-on-whitelist-error-for-urls/
  const ffmpegArgs = [
    '-f', 'concat', '-safe', '0', '-protocol_whitelist', 'file,pipe', '-i', '-',
    '-c', 'copy',

    ...(allStreams ? ['-map', '0'] : []),
    '-map_metadata', '0',

    // See https://github.com/mifi/lossless-cut/issues/170
    '-ignore_unknown',

    '-y', outPath,
  ];

  console.log('ffmpeg', ffmpegArgs.join(' '));

  // https://superuser.com/questions/787064/filename-quoting-in-ffmpeg-concat
  const concatTxt = paths.map(file => `file '${join(file).replace(/'/g, "'\\''")}'`).join('\n');

  console.log(concatTxt);

  const ffmpegPath = await getPath('ffmpeg');
  const process = execa(ffmpegPath, ffmpegArgs);

  stringToStream(concatTxt).pipe(process.stdin);

  const result = await process;
  console.log(result.stdout);
}

async function mergeAnyFiles({ customOutDir, paths, allStreams }) {
  const firstPath = paths[0];
  const ext = extname(firstPath);
  const outPath = getOutPath(customOutDir, firstPath, `merged${ext}`);
  return mergeFiles({ paths, outPath, allStreams });
}

async function autoMergeSegments({ customOutDir, sourceFile, segmentPaths }) {
  const ext = extname(sourceFile);
  const outPath = getOutPath(customOutDir, sourceFile, `cut-merged-${new Date().getTime()}${ext}`);
  await mergeFiles({ paths: segmentPaths, outPath });
  await pMap(segmentPaths, trash, { concurrency: 5 });
}

/**
 * ffmpeg only supports encoding certain formats, and some of the detected input
 * formats are not the same as the names used for encoding.
 * Therefore we have to map between detected format and encode format
 * See also ffmpeg -formats
 */
function mapFormat(requestedFormat) {
  switch (requestedFormat) {
    // These two cmds produce identical output, so we assume that encoding "ipod" means encoding m4a
    // ffmpeg -i example.aac -c copy OutputFile2.m4a
    // ffmpeg -i example.aac -c copy -f ipod OutputFile.m4a
    // See also https://github.com/mifi/lossless-cut/issues/28
    case 'm4a': return 'ipod';
    case 'aac': return 'ipod';
    default: return requestedFormat;
  }
}

function determineOutputFormat(ffprobeFormats, ft) {
  if (ffprobeFormats.includes(ft.ext)) return ft.ext;
  return ffprobeFormats[0] || undefined;
}

async function getFormat(filePath) {
  console.log('getFormat', filePath);

  const { stdout } = await runFfprobe([
    '-of', 'json', '-show_format', '-i', filePath,
  ]);
  const formatsStr = JSON.parse(stdout).format.format_name;
  console.log('formats', formatsStr);
  const formats = (formatsStr || '').split(',');

  // ffprobe sometimes returns a list of formats, try to be a bit smarter about it.
  const bytes = await readChunk(filePath, 0, 4100);
  const ft = fileType(bytes) || {};
  console.log(`fileType detected format ${JSON.stringify(ft)}`);
  const assumedFormat = determineOutputFormat(formats, ft);
  return mapFormat(assumedFormat);
}

async function getAllStreams(filePath) {
  const { stdout } = await runFfprobe([
    '-of', 'json', '-show_entries', 'stream', '-i', filePath,
  ]);

  return JSON.parse(stdout);
}

function getPreferredCodecFormat(codec, type) {
  const map = {
    mp3: 'mp3',
    opus: 'opus',
    vorbis: 'ogg',
    h264: 'mp4',
    hevc: 'mp4',
    eac3: 'eac3',

    subrip: 'srt',

    // See mapFormat
    m4a: 'ipod',
    aac: 'ipod',

    // TODO add more
    // TODO allow user to change?
  };

  const format = map[codec];
  if (format) return { format, ext: getExtensionForFormat(format) };
  if (type === 'video') return { ext: 'mkv', format: 'matroska' };
  if (type === 'audio') return { ext: 'mka', format: 'matroska' };
  if (type === 'subtitle') return { ext: 'mks', format: 'matroska' };
  if (type === 'data') return { ext: 'bin', format: 'data' }; // https://superuser.com/questions/1243257/save-data-stream
  return undefined;
}

// https://stackoverflow.com/questions/32922226/extract-every-audio-and-subtitles-from-a-video-with-ffmpeg
async function extractStreams({ filePath, customOutDir, streams }) {
  const outStreams = streams.map((s) => ({
    index: s.index,
    codec: s.codec_name || s.codec_tag_string || s.codec_type,
    type: s.codec_type,
    format: getPreferredCodecFormat(s.codec_name, s.codec_type),
  }))
    .filter(it => it && it.format && it.index != null);

  // console.log(outStreams);

  const streamArgs = flatMap(outStreams, ({
    index, codec, type, format: { format, ext },
  }) => [
    '-map', `0:${index}`, '-c', 'copy', '-f', format, '-y', getOutPath(customOutDir, filePath, `stream-${index}-${type}-${codec}.${ext}`),
  ]);

  const ffmpegArgs = [
    '-i', filePath,
    ...streamArgs,
  ];

  // TODO progress
  const { stdout } = await runFfmpeg(ffmpegArgs);
  console.log(stdout);
}

async function renderFrame(timestamp, filePath, rotation) {
  const transpose = {
    90: 'transpose=2',
    180: 'transpose=1,transpose=1',
    270: 'transpose=1',
  };
  const args = [
    '-ss', timestamp,
    ...(rotation !== undefined ? ['-noautorotate'] : []),
    '-i', filePath,
    // ...(rotation !== undefined ? ['-metadata:s:v:0', 'rotate=0'] : []), // Reset the rotation metadata first
    ...(rotation !== undefined && rotation > 0 ? ['-vf', `${transpose[rotation]}`] : []),
    '-f', 'image2',
    '-vframes', '1',
    '-q:v', '10',
    '-',
    // '-y', outPath,
  ];

  // console.time('ffmpeg');
  const ffmpegPath = await getPath('ffmpeg');
  // console.timeEnd('ffmpeg');
  // console.log('ffmpeg', args);
  const { stdout } = await execa(ffmpegPath, args, { encoding: null });

  const blob = new Blob([stdout], { type: 'image/jpeg' });
  const url = URL.createObjectURL(blob);
  return url;
}

// https://www.ffmpeg.org/doxygen/3.2/libavutil_2utils_8c_source.html#l00079
const defaultProcessedCodecTypes = [
  'video',
  'audio',
  'subtitle',
];

function getStreamFps(stream) {
  const match = typeof stream.avg_frame_rate === 'string' && stream.avg_frame_rate.match(/^([0-9]+)\/([0-9]+)$/);
  if (stream.codec_type === 'video' && match) {
    const num = parseInt(match[1], 10);
    const den = parseInt(match[2], 10);
    if (den > 0) return num / den;
  }
  return undefined;
}


module.exports = {
  cutMultiple,
  getFormat,
  html5ify,
  html5ifyDummy,
  mergeAnyFiles,
  autoMergeSegments,
  extractStreams,
  renderFrame,
  getAllStreams,
  defaultProcessedCodecTypes,
  getStreamFps,
  isCuttingStart,
  isCuttingEnd,
  readFrames,
  getNextPrevKeyframe,
};
