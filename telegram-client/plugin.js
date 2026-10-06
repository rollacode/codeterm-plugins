"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// node_modules/qrcode-generator/qrcode.js
var require_qrcode = __commonJS({
  "node_modules/qrcode-generator/qrcode.js"(exports, module2) {
    var qrcode2 = (function() {
      var qrcode3 = function(typeNumber, errorCorrectionLevel) {
        var PAD0 = 236;
        var PAD1 = 17;
        var _typeNumber = typeNumber;
        var _errorCorrectionLevel = QRErrorCorrectionLevel[errorCorrectionLevel];
        var _modules = null;
        var _moduleCount = 0;
        var _dataCache = null;
        var _dataList = [];
        var _this = {};
        var makeImpl = function(test, maskPattern) {
          _moduleCount = _typeNumber * 4 + 17;
          _modules = (function(moduleCount) {
            var modules = new Array(moduleCount);
            for (var row = 0; row < moduleCount; row += 1) {
              modules[row] = new Array(moduleCount);
              for (var col = 0; col < moduleCount; col += 1) {
                modules[row][col] = null;
              }
            }
            return modules;
          })(_moduleCount);
          setupPositionProbePattern(0, 0);
          setupPositionProbePattern(_moduleCount - 7, 0);
          setupPositionProbePattern(0, _moduleCount - 7);
          setupPositionAdjustPattern();
          setupTimingPattern();
          setupTypeInfo(test, maskPattern);
          if (_typeNumber >= 7) {
            setupTypeNumber(test);
          }
          if (_dataCache == null) {
            _dataCache = createData(_typeNumber, _errorCorrectionLevel, _dataList);
          }
          mapData(_dataCache, maskPattern);
        };
        var setupPositionProbePattern = function(row, col) {
          for (var r = -1; r <= 7; r += 1) {
            if (row + r <= -1 || _moduleCount <= row + r) continue;
            for (var c = -1; c <= 7; c += 1) {
              if (col + c <= -1 || _moduleCount <= col + c) continue;
              if (0 <= r && r <= 6 && (c == 0 || c == 6) || 0 <= c && c <= 6 && (r == 0 || r == 6) || 2 <= r && r <= 4 && 2 <= c && c <= 4) {
                _modules[row + r][col + c] = true;
              } else {
                _modules[row + r][col + c] = false;
              }
            }
          }
        };
        var getBestMaskPattern = function() {
          var minLostPoint = 0;
          var pattern = 0;
          for (var i = 0; i < 8; i += 1) {
            makeImpl(true, i);
            var lostPoint = QRUtil.getLostPoint(_this);
            if (i == 0 || minLostPoint > lostPoint) {
              minLostPoint = lostPoint;
              pattern = i;
            }
          }
          return pattern;
        };
        var setupTimingPattern = function() {
          for (var r = 8; r < _moduleCount - 8; r += 1) {
            if (_modules[r][6] != null) {
              continue;
            }
            _modules[r][6] = r % 2 == 0;
          }
          for (var c = 8; c < _moduleCount - 8; c += 1) {
            if (_modules[6][c] != null) {
              continue;
            }
            _modules[6][c] = c % 2 == 0;
          }
        };
        var setupPositionAdjustPattern = function() {
          var pos = QRUtil.getPatternPosition(_typeNumber);
          for (var i = 0; i < pos.length; i += 1) {
            for (var j = 0; j < pos.length; j += 1) {
              var row = pos[i];
              var col = pos[j];
              if (_modules[row][col] != null) {
                continue;
              }
              for (var r = -2; r <= 2; r += 1) {
                for (var c = -2; c <= 2; c += 1) {
                  if (r == -2 || r == 2 || c == -2 || c == 2 || r == 0 && c == 0) {
                    _modules[row + r][col + c] = true;
                  } else {
                    _modules[row + r][col + c] = false;
                  }
                }
              }
            }
          }
        };
        var setupTypeNumber = function(test) {
          var bits = QRUtil.getBCHTypeNumber(_typeNumber);
          for (var i = 0; i < 18; i += 1) {
            var mod = !test && (bits >> i & 1) == 1;
            _modules[Math.floor(i / 3)][i % 3 + _moduleCount - 8 - 3] = mod;
          }
          for (var i = 0; i < 18; i += 1) {
            var mod = !test && (bits >> i & 1) == 1;
            _modules[i % 3 + _moduleCount - 8 - 3][Math.floor(i / 3)] = mod;
          }
        };
        var setupTypeInfo = function(test, maskPattern) {
          var data = _errorCorrectionLevel << 3 | maskPattern;
          var bits = QRUtil.getBCHTypeInfo(data);
          for (var i = 0; i < 15; i += 1) {
            var mod = !test && (bits >> i & 1) == 1;
            if (i < 6) {
              _modules[i][8] = mod;
            } else if (i < 8) {
              _modules[i + 1][8] = mod;
            } else {
              _modules[_moduleCount - 15 + i][8] = mod;
            }
          }
          for (var i = 0; i < 15; i += 1) {
            var mod = !test && (bits >> i & 1) == 1;
            if (i < 8) {
              _modules[8][_moduleCount - i - 1] = mod;
            } else if (i < 9) {
              _modules[8][15 - i - 1 + 1] = mod;
            } else {
              _modules[8][15 - i - 1] = mod;
            }
          }
          _modules[_moduleCount - 8][8] = !test;
        };
        var mapData = function(data, maskPattern) {
          var inc = -1;
          var row = _moduleCount - 1;
          var bitIndex = 7;
          var byteIndex = 0;
          var maskFunc = QRUtil.getMaskFunction(maskPattern);
          for (var col = _moduleCount - 1; col > 0; col -= 2) {
            if (col == 6) col -= 1;
            while (true) {
              for (var c = 0; c < 2; c += 1) {
                if (_modules[row][col - c] == null) {
                  var dark = false;
                  if (byteIndex < data.length) {
                    dark = (data[byteIndex] >>> bitIndex & 1) == 1;
                  }
                  var mask = maskFunc(row, col - c);
                  if (mask) {
                    dark = !dark;
                  }
                  _modules[row][col - c] = dark;
                  bitIndex -= 1;
                  if (bitIndex == -1) {
                    byteIndex += 1;
                    bitIndex = 7;
                  }
                }
              }
              row += inc;
              if (row < 0 || _moduleCount <= row) {
                row -= inc;
                inc = -inc;
                break;
              }
            }
          }
        };
        var createBytes = function(buffer, rsBlocks) {
          var offset = 0;
          var maxDcCount = 0;
          var maxEcCount = 0;
          var dcdata = new Array(rsBlocks.length);
          var ecdata = new Array(rsBlocks.length);
          for (var r = 0; r < rsBlocks.length; r += 1) {
            var dcCount = rsBlocks[r].dataCount;
            var ecCount = rsBlocks[r].totalCount - dcCount;
            maxDcCount = Math.max(maxDcCount, dcCount);
            maxEcCount = Math.max(maxEcCount, ecCount);
            dcdata[r] = new Array(dcCount);
            for (var i = 0; i < dcdata[r].length; i += 1) {
              dcdata[r][i] = 255 & buffer.getBuffer()[i + offset];
            }
            offset += dcCount;
            var rsPoly = QRUtil.getErrorCorrectPolynomial(ecCount);
            var rawPoly = qrPolynomial(dcdata[r], rsPoly.getLength() - 1);
            var modPoly = rawPoly.mod(rsPoly);
            ecdata[r] = new Array(rsPoly.getLength() - 1);
            for (var i = 0; i < ecdata[r].length; i += 1) {
              var modIndex = i + modPoly.getLength() - ecdata[r].length;
              ecdata[r][i] = modIndex >= 0 ? modPoly.getAt(modIndex) : 0;
            }
          }
          var totalCodeCount = 0;
          for (var i = 0; i < rsBlocks.length; i += 1) {
            totalCodeCount += rsBlocks[i].totalCount;
          }
          var data = new Array(totalCodeCount);
          var index = 0;
          for (var i = 0; i < maxDcCount; i += 1) {
            for (var r = 0; r < rsBlocks.length; r += 1) {
              if (i < dcdata[r].length) {
                data[index] = dcdata[r][i];
                index += 1;
              }
            }
          }
          for (var i = 0; i < maxEcCount; i += 1) {
            for (var r = 0; r < rsBlocks.length; r += 1) {
              if (i < ecdata[r].length) {
                data[index] = ecdata[r][i];
                index += 1;
              }
            }
          }
          return data;
        };
        var createData = function(typeNumber2, errorCorrectionLevel2, dataList) {
          var rsBlocks = QRRSBlock.getRSBlocks(typeNumber2, errorCorrectionLevel2);
          var buffer = qrBitBuffer();
          for (var i = 0; i < dataList.length; i += 1) {
            var data = dataList[i];
            buffer.put(data.getMode(), 4);
            buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber2));
            data.write(buffer);
          }
          var totalDataCount = 0;
          for (var i = 0; i < rsBlocks.length; i += 1) {
            totalDataCount += rsBlocks[i].dataCount;
          }
          if (buffer.getLengthInBits() > totalDataCount * 8) {
            throw "code length overflow. (" + buffer.getLengthInBits() + ">" + totalDataCount * 8 + ")";
          }
          if (buffer.getLengthInBits() + 4 <= totalDataCount * 8) {
            buffer.put(0, 4);
          }
          while (buffer.getLengthInBits() % 8 != 0) {
            buffer.putBit(false);
          }
          while (true) {
            if (buffer.getLengthInBits() >= totalDataCount * 8) {
              break;
            }
            buffer.put(PAD0, 8);
            if (buffer.getLengthInBits() >= totalDataCount * 8) {
              break;
            }
            buffer.put(PAD1, 8);
          }
          return createBytes(buffer, rsBlocks);
        };
        _this.addData = function(data, mode) {
          mode = mode || "Byte";
          var newData = null;
          switch (mode) {
            case "Numeric":
              newData = qrNumber(data);
              break;
            case "Alphanumeric":
              newData = qrAlphaNum(data);
              break;
            case "Byte":
              newData = qr8BitByte(data);
              break;
            case "Kanji":
              newData = qrKanji(data);
              break;
            default:
              throw "mode:" + mode;
          }
          _dataList.push(newData);
          _dataCache = null;
        };
        _this.isDark = function(row, col) {
          if (row < 0 || _moduleCount <= row || col < 0 || _moduleCount <= col) {
            throw row + "," + col;
          }
          return _modules[row][col];
        };
        _this.getModuleCount = function() {
          return _moduleCount;
        };
        _this.make = function() {
          if (_typeNumber < 1) {
            var typeNumber2 = 1;
            for (; typeNumber2 < 40; typeNumber2++) {
              var rsBlocks = QRRSBlock.getRSBlocks(typeNumber2, _errorCorrectionLevel);
              var buffer = qrBitBuffer();
              for (var i = 0; i < _dataList.length; i++) {
                var data = _dataList[i];
                buffer.put(data.getMode(), 4);
                buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber2));
                data.write(buffer);
              }
              var totalDataCount = 0;
              for (var i = 0; i < rsBlocks.length; i++) {
                totalDataCount += rsBlocks[i].dataCount;
              }
              if (buffer.getLengthInBits() <= totalDataCount * 8) {
                break;
              }
            }
            _typeNumber = typeNumber2;
          }
          makeImpl(false, getBestMaskPattern());
        };
        _this.createTableTag = function(cellSize, margin) {
          cellSize = cellSize || 2;
          margin = typeof margin == "undefined" ? cellSize * 4 : margin;
          var qrHtml = "";
          qrHtml += '<table style="';
          qrHtml += " border-width: 0px; border-style: none;";
          qrHtml += " border-collapse: collapse;";
          qrHtml += " padding: 0px; margin: " + margin + "px;";
          qrHtml += '">';
          qrHtml += "<tbody>";
          for (var r = 0; r < _this.getModuleCount(); r += 1) {
            qrHtml += "<tr>";
            for (var c = 0; c < _this.getModuleCount(); c += 1) {
              qrHtml += '<td style="';
              qrHtml += " border-width: 0px; border-style: none;";
              qrHtml += " border-collapse: collapse;";
              qrHtml += " padding: 0px; margin: 0px;";
              qrHtml += " width: " + cellSize + "px;";
              qrHtml += " height: " + cellSize + "px;";
              qrHtml += " background-color: ";
              qrHtml += _this.isDark(r, c) ? "#000000" : "#ffffff";
              qrHtml += ";";
              qrHtml += '"/>';
            }
            qrHtml += "</tr>";
          }
          qrHtml += "</tbody>";
          qrHtml += "</table>";
          return qrHtml;
        };
        _this.createSvgTag = function(cellSize, margin, alt, title) {
          var opts = {};
          if (typeof arguments[0] == "object") {
            opts = arguments[0];
            cellSize = opts.cellSize;
            margin = opts.margin;
            alt = opts.alt;
            title = opts.title;
          }
          cellSize = cellSize || 2;
          margin = typeof margin == "undefined" ? cellSize * 4 : margin;
          alt = typeof alt === "string" ? { text: alt } : alt || {};
          alt.text = alt.text || null;
          alt.id = alt.text ? alt.id || "qrcode-description" : null;
          title = typeof title === "string" ? { text: title } : title || {};
          title.text = title.text || null;
          title.id = title.text ? title.id || "qrcode-title" : null;
          var size = _this.getModuleCount() * cellSize + margin * 2;
          var c, mc, r, mr, qrSvg2 = "", rect;
          rect = "l" + cellSize + ",0 0," + cellSize + " -" + cellSize + ",0 0,-" + cellSize + "z ";
          qrSvg2 += '<svg version="1.1" xmlns="http://www.w3.org/2000/svg"';
          qrSvg2 += !opts.scalable ? ' width="' + size + 'px" height="' + size + 'px"' : "";
          qrSvg2 += ' viewBox="0 0 ' + size + " " + size + '" ';
          qrSvg2 += ' preserveAspectRatio="xMinYMin meet"';
          qrSvg2 += title.text || alt.text ? ' role="img" aria-labelledby="' + escapeXml([title.id, alt.id].join(" ").trim()) + '"' : "";
          qrSvg2 += ">";
          qrSvg2 += title.text ? '<title id="' + escapeXml(title.id) + '">' + escapeXml(title.text) + "</title>" : "";
          qrSvg2 += alt.text ? '<description id="' + escapeXml(alt.id) + '">' + escapeXml(alt.text) + "</description>" : "";
          qrSvg2 += '<rect width="100%" height="100%" fill="white" cx="0" cy="0"/>';
          qrSvg2 += '<path d="';
          for (r = 0; r < _this.getModuleCount(); r += 1) {
            mr = r * cellSize + margin;
            for (c = 0; c < _this.getModuleCount(); c += 1) {
              if (_this.isDark(r, c)) {
                mc = c * cellSize + margin;
                qrSvg2 += "M" + mc + "," + mr + rect;
              }
            }
          }
          qrSvg2 += '" stroke="transparent" fill="black"/>';
          qrSvg2 += "</svg>";
          return qrSvg2;
        };
        _this.createDataURL = function(cellSize, margin) {
          cellSize = cellSize || 2;
          margin = typeof margin == "undefined" ? cellSize * 4 : margin;
          var size = _this.getModuleCount() * cellSize + margin * 2;
          var min = margin;
          var max = size - margin;
          return createDataURL(size, size, function(x, y) {
            if (min <= x && x < max && min <= y && y < max) {
              var c = Math.floor((x - min) / cellSize);
              var r = Math.floor((y - min) / cellSize);
              return _this.isDark(r, c) ? 0 : 1;
            } else {
              return 1;
            }
          });
        };
        _this.createImgTag = function(cellSize, margin, alt) {
          cellSize = cellSize || 2;
          margin = typeof margin == "undefined" ? cellSize * 4 : margin;
          var size = _this.getModuleCount() * cellSize + margin * 2;
          var img = "";
          img += "<img";
          img += ' src="';
          img += _this.createDataURL(cellSize, margin);
          img += '"';
          img += ' width="';
          img += size;
          img += '"';
          img += ' height="';
          img += size;
          img += '"';
          if (alt) {
            img += ' alt="';
            img += escapeXml(alt);
            img += '"';
          }
          img += "/>";
          return img;
        };
        var escapeXml = function(s) {
          var escaped = "";
          for (var i = 0; i < s.length; i += 1) {
            var c = s.charAt(i);
            switch (c) {
              case "<":
                escaped += "&lt;";
                break;
              case ">":
                escaped += "&gt;";
                break;
              case "&":
                escaped += "&amp;";
                break;
              case '"':
                escaped += "&quot;";
                break;
              default:
                escaped += c;
                break;
            }
          }
          return escaped;
        };
        var _createHalfASCII = function(margin) {
          var cellSize = 1;
          margin = typeof margin == "undefined" ? cellSize * 2 : margin;
          var size = _this.getModuleCount() * cellSize + margin * 2;
          var min = margin;
          var max = size - margin;
          var y, x, r1, r2, p;
          var blocks = {
            "\u2588\u2588": "\u2588",
            "\u2588 ": "\u2580",
            " \u2588": "\u2584",
            "  ": " "
          };
          var blocksLastLineNoMargin = {
            "\u2588\u2588": "\u2580",
            "\u2588 ": "\u2580",
            " \u2588": " ",
            "  ": " "
          };
          var ascii = "";
          for (y = 0; y < size; y += 2) {
            r1 = Math.floor((y - min) / cellSize);
            r2 = Math.floor((y + 1 - min) / cellSize);
            for (x = 0; x < size; x += 1) {
              p = "\u2588";
              if (min <= x && x < max && min <= y && y < max && _this.isDark(r1, Math.floor((x - min) / cellSize))) {
                p = " ";
              }
              if (min <= x && x < max && min <= y + 1 && y + 1 < max && _this.isDark(r2, Math.floor((x - min) / cellSize))) {
                p += " ";
              } else {
                p += "\u2588";
              }
              ascii += margin < 1 && y + 1 >= max ? blocksLastLineNoMargin[p] : blocks[p];
            }
            ascii += "\n";
          }
          if (size % 2 && margin > 0) {
            return ascii.substring(0, ascii.length - size - 1) + Array(size + 1).join("\u2580");
          }
          return ascii.substring(0, ascii.length - 1);
        };
        _this.createASCII = function(cellSize, margin) {
          cellSize = cellSize || 1;
          if (cellSize < 2) {
            return _createHalfASCII(margin);
          }
          cellSize -= 1;
          margin = typeof margin == "undefined" ? cellSize * 2 : margin;
          var size = _this.getModuleCount() * cellSize + margin * 2;
          var min = margin;
          var max = size - margin;
          var y, x, r, p;
          var white = Array(cellSize + 1).join("\u2588\u2588");
          var black = Array(cellSize + 1).join("  ");
          var ascii = "";
          var line = "";
          for (y = 0; y < size; y += 1) {
            r = Math.floor((y - min) / cellSize);
            line = "";
            for (x = 0; x < size; x += 1) {
              p = 1;
              if (min <= x && x < max && min <= y && y < max && _this.isDark(r, Math.floor((x - min) / cellSize))) {
                p = 0;
              }
              line += p ? white : black;
            }
            for (r = 0; r < cellSize; r += 1) {
              ascii += line + "\n";
            }
          }
          return ascii.substring(0, ascii.length - 1);
        };
        _this.renderTo2dContext = function(context, cellSize) {
          cellSize = cellSize || 2;
          var length = _this.getModuleCount();
          for (var row = 0; row < length; row++) {
            for (var col = 0; col < length; col++) {
              context.fillStyle = _this.isDark(row, col) ? "black" : "white";
              context.fillRect(row * cellSize, col * cellSize, cellSize, cellSize);
            }
          }
        };
        return _this;
      };
      qrcode3.stringToBytesFuncs = {
        "default": function(s) {
          var bytes = [];
          for (var i = 0; i < s.length; i += 1) {
            var c = s.charCodeAt(i);
            bytes.push(c & 255);
          }
          return bytes;
        }
      };
      qrcode3.stringToBytes = qrcode3.stringToBytesFuncs["default"];
      qrcode3.createStringToBytes = function(unicodeData, numChars) {
        var unicodeMap = (function() {
          var bin = base64DecodeInputStream(unicodeData);
          var read = function() {
            var b = bin.read();
            if (b == -1) throw "eof";
            return b;
          };
          var count = 0;
          var unicodeMap2 = {};
          while (true) {
            var b0 = bin.read();
            if (b0 == -1) break;
            var b1 = read();
            var b2 = read();
            var b3 = read();
            var k = String.fromCharCode(b0 << 8 | b1);
            var v = b2 << 8 | b3;
            unicodeMap2[k] = v;
            count += 1;
          }
          if (count != numChars) {
            throw count + " != " + numChars;
          }
          return unicodeMap2;
        })();
        var unknownChar = "?".charCodeAt(0);
        return function(s) {
          var bytes = [];
          for (var i = 0; i < s.length; i += 1) {
            var c = s.charCodeAt(i);
            if (c < 128) {
              bytes.push(c);
            } else {
              var b = unicodeMap[s.charAt(i)];
              if (typeof b == "number") {
                if ((b & 255) == b) {
                  bytes.push(b);
                } else {
                  bytes.push(b >>> 8);
                  bytes.push(b & 255);
                }
              } else {
                bytes.push(unknownChar);
              }
            }
          }
          return bytes;
        };
      };
      var QRMode = {
        MODE_NUMBER: 1 << 0,
        MODE_ALPHA_NUM: 1 << 1,
        MODE_8BIT_BYTE: 1 << 2,
        MODE_KANJI: 1 << 3
      };
      var QRErrorCorrectionLevel = {
        L: 1,
        M: 0,
        Q: 3,
        H: 2
      };
      var QRMaskPattern = {
        PATTERN000: 0,
        PATTERN001: 1,
        PATTERN010: 2,
        PATTERN011: 3,
        PATTERN100: 4,
        PATTERN101: 5,
        PATTERN110: 6,
        PATTERN111: 7
      };
      var QRUtil = (function() {
        var PATTERN_POSITION_TABLE = [
          [],
          [6, 18],
          [6, 22],
          [6, 26],
          [6, 30],
          [6, 34],
          [6, 22, 38],
          [6, 24, 42],
          [6, 26, 46],
          [6, 28, 50],
          [6, 30, 54],
          [6, 32, 58],
          [6, 34, 62],
          [6, 26, 46, 66],
          [6, 26, 48, 70],
          [6, 26, 50, 74],
          [6, 30, 54, 78],
          [6, 30, 56, 82],
          [6, 30, 58, 86],
          [6, 34, 62, 90],
          [6, 28, 50, 72, 94],
          [6, 26, 50, 74, 98],
          [6, 30, 54, 78, 102],
          [6, 28, 54, 80, 106],
          [6, 32, 58, 84, 110],
          [6, 30, 58, 86, 114],
          [6, 34, 62, 90, 118],
          [6, 26, 50, 74, 98, 122],
          [6, 30, 54, 78, 102, 126],
          [6, 26, 52, 78, 104, 130],
          [6, 30, 56, 82, 108, 134],
          [6, 34, 60, 86, 112, 138],
          [6, 30, 58, 86, 114, 142],
          [6, 34, 62, 90, 118, 146],
          [6, 30, 54, 78, 102, 126, 150],
          [6, 24, 50, 76, 102, 128, 154],
          [6, 28, 54, 80, 106, 132, 158],
          [6, 32, 58, 84, 110, 136, 162],
          [6, 26, 54, 82, 110, 138, 166],
          [6, 30, 58, 86, 114, 142, 170]
        ];
        var G15 = 1 << 10 | 1 << 8 | 1 << 5 | 1 << 4 | 1 << 2 | 1 << 1 | 1 << 0;
        var G18 = 1 << 12 | 1 << 11 | 1 << 10 | 1 << 9 | 1 << 8 | 1 << 5 | 1 << 2 | 1 << 0;
        var G15_MASK = 1 << 14 | 1 << 12 | 1 << 10 | 1 << 4 | 1 << 1;
        var _this = {};
        var getBCHDigit = function(data) {
          var digit = 0;
          while (data != 0) {
            digit += 1;
            data >>>= 1;
          }
          return digit;
        };
        _this.getBCHTypeInfo = function(data) {
          var d = data << 10;
          while (getBCHDigit(d) - getBCHDigit(G15) >= 0) {
            d ^= G15 << getBCHDigit(d) - getBCHDigit(G15);
          }
          return (data << 10 | d) ^ G15_MASK;
        };
        _this.getBCHTypeNumber = function(data) {
          var d = data << 12;
          while (getBCHDigit(d) - getBCHDigit(G18) >= 0) {
            d ^= G18 << getBCHDigit(d) - getBCHDigit(G18);
          }
          return data << 12 | d;
        };
        _this.getPatternPosition = function(typeNumber) {
          return PATTERN_POSITION_TABLE[typeNumber - 1];
        };
        _this.getMaskFunction = function(maskPattern) {
          switch (maskPattern) {
            case QRMaskPattern.PATTERN000:
              return function(i, j) {
                return (i + j) % 2 == 0;
              };
            case QRMaskPattern.PATTERN001:
              return function(i, j) {
                return i % 2 == 0;
              };
            case QRMaskPattern.PATTERN010:
              return function(i, j) {
                return j % 3 == 0;
              };
            case QRMaskPattern.PATTERN011:
              return function(i, j) {
                return (i + j) % 3 == 0;
              };
            case QRMaskPattern.PATTERN100:
              return function(i, j) {
                return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 == 0;
              };
            case QRMaskPattern.PATTERN101:
              return function(i, j) {
                return i * j % 2 + i * j % 3 == 0;
              };
            case QRMaskPattern.PATTERN110:
              return function(i, j) {
                return (i * j % 2 + i * j % 3) % 2 == 0;
              };
            case QRMaskPattern.PATTERN111:
              return function(i, j) {
                return (i * j % 3 + (i + j) % 2) % 2 == 0;
              };
            default:
              throw "bad maskPattern:" + maskPattern;
          }
        };
        _this.getErrorCorrectPolynomial = function(errorCorrectLength) {
          var a = qrPolynomial([1], 0);
          for (var i = 0; i < errorCorrectLength; i += 1) {
            a = a.multiply(qrPolynomial([1, QRMath.gexp(i)], 0));
          }
          return a;
        };
        _this.getLengthInBits = function(mode, type) {
          if (1 <= type && type < 10) {
            switch (mode) {
              case QRMode.MODE_NUMBER:
                return 10;
              case QRMode.MODE_ALPHA_NUM:
                return 9;
              case QRMode.MODE_8BIT_BYTE:
                return 8;
              case QRMode.MODE_KANJI:
                return 8;
              default:
                throw "mode:" + mode;
            }
          } else if (type < 27) {
            switch (mode) {
              case QRMode.MODE_NUMBER:
                return 12;
              case QRMode.MODE_ALPHA_NUM:
                return 11;
              case QRMode.MODE_8BIT_BYTE:
                return 16;
              case QRMode.MODE_KANJI:
                return 10;
              default:
                throw "mode:" + mode;
            }
          } else if (type < 41) {
            switch (mode) {
              case QRMode.MODE_NUMBER:
                return 14;
              case QRMode.MODE_ALPHA_NUM:
                return 13;
              case QRMode.MODE_8BIT_BYTE:
                return 16;
              case QRMode.MODE_KANJI:
                return 12;
              default:
                throw "mode:" + mode;
            }
          } else {
            throw "type:" + type;
          }
        };
        _this.getLostPoint = function(qrcode4) {
          var moduleCount = qrcode4.getModuleCount();
          var lostPoint = 0;
          for (var row = 0; row < moduleCount; row += 1) {
            for (var col = 0; col < moduleCount; col += 1) {
              var sameCount = 0;
              var dark = qrcode4.isDark(row, col);
              for (var r = -1; r <= 1; r += 1) {
                if (row + r < 0 || moduleCount <= row + r) {
                  continue;
                }
                for (var c = -1; c <= 1; c += 1) {
                  if (col + c < 0 || moduleCount <= col + c) {
                    continue;
                  }
                  if (r == 0 && c == 0) {
                    continue;
                  }
                  if (dark == qrcode4.isDark(row + r, col + c)) {
                    sameCount += 1;
                  }
                }
              }
              if (sameCount > 5) {
                lostPoint += 3 + sameCount - 5;
              }
            }
          }
          ;
          for (var row = 0; row < moduleCount - 1; row += 1) {
            for (var col = 0; col < moduleCount - 1; col += 1) {
              var count = 0;
              if (qrcode4.isDark(row, col)) count += 1;
              if (qrcode4.isDark(row + 1, col)) count += 1;
              if (qrcode4.isDark(row, col + 1)) count += 1;
              if (qrcode4.isDark(row + 1, col + 1)) count += 1;
              if (count == 0 || count == 4) {
                lostPoint += 3;
              }
            }
          }
          for (var row = 0; row < moduleCount; row += 1) {
            for (var col = 0; col < moduleCount - 6; col += 1) {
              if (qrcode4.isDark(row, col) && !qrcode4.isDark(row, col + 1) && qrcode4.isDark(row, col + 2) && qrcode4.isDark(row, col + 3) && qrcode4.isDark(row, col + 4) && !qrcode4.isDark(row, col + 5) && qrcode4.isDark(row, col + 6)) {
                lostPoint += 40;
              }
            }
          }
          for (var col = 0; col < moduleCount; col += 1) {
            for (var row = 0; row < moduleCount - 6; row += 1) {
              if (qrcode4.isDark(row, col) && !qrcode4.isDark(row + 1, col) && qrcode4.isDark(row + 2, col) && qrcode4.isDark(row + 3, col) && qrcode4.isDark(row + 4, col) && !qrcode4.isDark(row + 5, col) && qrcode4.isDark(row + 6, col)) {
                lostPoint += 40;
              }
            }
          }
          var darkCount = 0;
          for (var col = 0; col < moduleCount; col += 1) {
            for (var row = 0; row < moduleCount; row += 1) {
              if (qrcode4.isDark(row, col)) {
                darkCount += 1;
              }
            }
          }
          var ratio = Math.abs(100 * darkCount / moduleCount / moduleCount - 50) / 5;
          lostPoint += ratio * 10;
          return lostPoint;
        };
        return _this;
      })();
      var QRMath = (function() {
        var EXP_TABLE = new Array(256);
        var LOG_TABLE = new Array(256);
        for (var i = 0; i < 8; i += 1) {
          EXP_TABLE[i] = 1 << i;
        }
        for (var i = 8; i < 256; i += 1) {
          EXP_TABLE[i] = EXP_TABLE[i - 4] ^ EXP_TABLE[i - 5] ^ EXP_TABLE[i - 6] ^ EXP_TABLE[i - 8];
        }
        for (var i = 0; i < 255; i += 1) {
          LOG_TABLE[EXP_TABLE[i]] = i;
        }
        var _this = {};
        _this.glog = function(n) {
          if (n < 1) {
            throw "glog(" + n + ")";
          }
          return LOG_TABLE[n];
        };
        _this.gexp = function(n) {
          while (n < 0) {
            n += 255;
          }
          while (n >= 256) {
            n -= 255;
          }
          return EXP_TABLE[n];
        };
        return _this;
      })();
      function qrPolynomial(num, shift) {
        if (typeof num.length == "undefined") {
          throw num.length + "/" + shift;
        }
        var _num = (function() {
          var offset = 0;
          while (offset < num.length && num[offset] == 0) {
            offset += 1;
          }
          var _num2 = new Array(num.length - offset + shift);
          for (var i = 0; i < num.length - offset; i += 1) {
            _num2[i] = num[i + offset];
          }
          return _num2;
        })();
        var _this = {};
        _this.getAt = function(index) {
          return _num[index];
        };
        _this.getLength = function() {
          return _num.length;
        };
        _this.multiply = function(e) {
          var num2 = new Array(_this.getLength() + e.getLength() - 1);
          for (var i = 0; i < _this.getLength(); i += 1) {
            for (var j = 0; j < e.getLength(); j += 1) {
              num2[i + j] ^= QRMath.gexp(QRMath.glog(_this.getAt(i)) + QRMath.glog(e.getAt(j)));
            }
          }
          return qrPolynomial(num2, 0);
        };
        _this.mod = function(e) {
          if (_this.getLength() - e.getLength() < 0) {
            return _this;
          }
          var ratio = QRMath.glog(_this.getAt(0)) - QRMath.glog(e.getAt(0));
          var num2 = new Array(_this.getLength());
          for (var i = 0; i < _this.getLength(); i += 1) {
            num2[i] = _this.getAt(i);
          }
          for (var i = 0; i < e.getLength(); i += 1) {
            num2[i] ^= QRMath.gexp(QRMath.glog(e.getAt(i)) + ratio);
          }
          return qrPolynomial(num2, 0).mod(e);
        };
        return _this;
      }
      ;
      var QRRSBlock = (function() {
        var RS_BLOCK_TABLE = [
          // L
          // M
          // Q
          // H
          // 1
          [1, 26, 19],
          [1, 26, 16],
          [1, 26, 13],
          [1, 26, 9],
          // 2
          [1, 44, 34],
          [1, 44, 28],
          [1, 44, 22],
          [1, 44, 16],
          // 3
          [1, 70, 55],
          [1, 70, 44],
          [2, 35, 17],
          [2, 35, 13],
          // 4
          [1, 100, 80],
          [2, 50, 32],
          [2, 50, 24],
          [4, 25, 9],
          // 5
          [1, 134, 108],
          [2, 67, 43],
          [2, 33, 15, 2, 34, 16],
          [2, 33, 11, 2, 34, 12],
          // 6
          [2, 86, 68],
          [4, 43, 27],
          [4, 43, 19],
          [4, 43, 15],
          // 7
          [2, 98, 78],
          [4, 49, 31],
          [2, 32, 14, 4, 33, 15],
          [4, 39, 13, 1, 40, 14],
          // 8
          [2, 121, 97],
          [2, 60, 38, 2, 61, 39],
          [4, 40, 18, 2, 41, 19],
          [4, 40, 14, 2, 41, 15],
          // 9
          [2, 146, 116],
          [3, 58, 36, 2, 59, 37],
          [4, 36, 16, 4, 37, 17],
          [4, 36, 12, 4, 37, 13],
          // 10
          [2, 86, 68, 2, 87, 69],
          [4, 69, 43, 1, 70, 44],
          [6, 43, 19, 2, 44, 20],
          [6, 43, 15, 2, 44, 16],
          // 11
          [4, 101, 81],
          [1, 80, 50, 4, 81, 51],
          [4, 50, 22, 4, 51, 23],
          [3, 36, 12, 8, 37, 13],
          // 12
          [2, 116, 92, 2, 117, 93],
          [6, 58, 36, 2, 59, 37],
          [4, 46, 20, 6, 47, 21],
          [7, 42, 14, 4, 43, 15],
          // 13
          [4, 133, 107],
          [8, 59, 37, 1, 60, 38],
          [8, 44, 20, 4, 45, 21],
          [12, 33, 11, 4, 34, 12],
          // 14
          [3, 145, 115, 1, 146, 116],
          [4, 64, 40, 5, 65, 41],
          [11, 36, 16, 5, 37, 17],
          [11, 36, 12, 5, 37, 13],
          // 15
          [5, 109, 87, 1, 110, 88],
          [5, 65, 41, 5, 66, 42],
          [5, 54, 24, 7, 55, 25],
          [11, 36, 12, 7, 37, 13],
          // 16
          [5, 122, 98, 1, 123, 99],
          [7, 73, 45, 3, 74, 46],
          [15, 43, 19, 2, 44, 20],
          [3, 45, 15, 13, 46, 16],
          // 17
          [1, 135, 107, 5, 136, 108],
          [10, 74, 46, 1, 75, 47],
          [1, 50, 22, 15, 51, 23],
          [2, 42, 14, 17, 43, 15],
          // 18
          [5, 150, 120, 1, 151, 121],
          [9, 69, 43, 4, 70, 44],
          [17, 50, 22, 1, 51, 23],
          [2, 42, 14, 19, 43, 15],
          // 19
          [3, 141, 113, 4, 142, 114],
          [3, 70, 44, 11, 71, 45],
          [17, 47, 21, 4, 48, 22],
          [9, 39, 13, 16, 40, 14],
          // 20
          [3, 135, 107, 5, 136, 108],
          [3, 67, 41, 13, 68, 42],
          [15, 54, 24, 5, 55, 25],
          [15, 43, 15, 10, 44, 16],
          // 21
          [4, 144, 116, 4, 145, 117],
          [17, 68, 42],
          [17, 50, 22, 6, 51, 23],
          [19, 46, 16, 6, 47, 17],
          // 22
          [2, 139, 111, 7, 140, 112],
          [17, 74, 46],
          [7, 54, 24, 16, 55, 25],
          [34, 37, 13],
          // 23
          [4, 151, 121, 5, 152, 122],
          [4, 75, 47, 14, 76, 48],
          [11, 54, 24, 14, 55, 25],
          [16, 45, 15, 14, 46, 16],
          // 24
          [6, 147, 117, 4, 148, 118],
          [6, 73, 45, 14, 74, 46],
          [11, 54, 24, 16, 55, 25],
          [30, 46, 16, 2, 47, 17],
          // 25
          [8, 132, 106, 4, 133, 107],
          [8, 75, 47, 13, 76, 48],
          [7, 54, 24, 22, 55, 25],
          [22, 45, 15, 13, 46, 16],
          // 26
          [10, 142, 114, 2, 143, 115],
          [19, 74, 46, 4, 75, 47],
          [28, 50, 22, 6, 51, 23],
          [33, 46, 16, 4, 47, 17],
          // 27
          [8, 152, 122, 4, 153, 123],
          [22, 73, 45, 3, 74, 46],
          [8, 53, 23, 26, 54, 24],
          [12, 45, 15, 28, 46, 16],
          // 28
          [3, 147, 117, 10, 148, 118],
          [3, 73, 45, 23, 74, 46],
          [4, 54, 24, 31, 55, 25],
          [11, 45, 15, 31, 46, 16],
          // 29
          [7, 146, 116, 7, 147, 117],
          [21, 73, 45, 7, 74, 46],
          [1, 53, 23, 37, 54, 24],
          [19, 45, 15, 26, 46, 16],
          // 30
          [5, 145, 115, 10, 146, 116],
          [19, 75, 47, 10, 76, 48],
          [15, 54, 24, 25, 55, 25],
          [23, 45, 15, 25, 46, 16],
          // 31
          [13, 145, 115, 3, 146, 116],
          [2, 74, 46, 29, 75, 47],
          [42, 54, 24, 1, 55, 25],
          [23, 45, 15, 28, 46, 16],
          // 32
          [17, 145, 115],
          [10, 74, 46, 23, 75, 47],
          [10, 54, 24, 35, 55, 25],
          [19, 45, 15, 35, 46, 16],
          // 33
          [17, 145, 115, 1, 146, 116],
          [14, 74, 46, 21, 75, 47],
          [29, 54, 24, 19, 55, 25],
          [11, 45, 15, 46, 46, 16],
          // 34
          [13, 145, 115, 6, 146, 116],
          [14, 74, 46, 23, 75, 47],
          [44, 54, 24, 7, 55, 25],
          [59, 46, 16, 1, 47, 17],
          // 35
          [12, 151, 121, 7, 152, 122],
          [12, 75, 47, 26, 76, 48],
          [39, 54, 24, 14, 55, 25],
          [22, 45, 15, 41, 46, 16],
          // 36
          [6, 151, 121, 14, 152, 122],
          [6, 75, 47, 34, 76, 48],
          [46, 54, 24, 10, 55, 25],
          [2, 45, 15, 64, 46, 16],
          // 37
          [17, 152, 122, 4, 153, 123],
          [29, 74, 46, 14, 75, 47],
          [49, 54, 24, 10, 55, 25],
          [24, 45, 15, 46, 46, 16],
          // 38
          [4, 152, 122, 18, 153, 123],
          [13, 74, 46, 32, 75, 47],
          [48, 54, 24, 14, 55, 25],
          [42, 45, 15, 32, 46, 16],
          // 39
          [20, 147, 117, 4, 148, 118],
          [40, 75, 47, 7, 76, 48],
          [43, 54, 24, 22, 55, 25],
          [10, 45, 15, 67, 46, 16],
          // 40
          [19, 148, 118, 6, 149, 119],
          [18, 75, 47, 31, 76, 48],
          [34, 54, 24, 34, 55, 25],
          [20, 45, 15, 61, 46, 16]
        ];
        var qrRSBlock = function(totalCount, dataCount) {
          var _this2 = {};
          _this2.totalCount = totalCount;
          _this2.dataCount = dataCount;
          return _this2;
        };
        var _this = {};
        var getRsBlockTable = function(typeNumber, errorCorrectionLevel) {
          switch (errorCorrectionLevel) {
            case QRErrorCorrectionLevel.L:
              return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 0];
            case QRErrorCorrectionLevel.M:
              return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 1];
            case QRErrorCorrectionLevel.Q:
              return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 2];
            case QRErrorCorrectionLevel.H:
              return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 3];
            default:
              return void 0;
          }
        };
        _this.getRSBlocks = function(typeNumber, errorCorrectionLevel) {
          var rsBlock = getRsBlockTable(typeNumber, errorCorrectionLevel);
          if (typeof rsBlock == "undefined") {
            throw "bad rs block @ typeNumber:" + typeNumber + "/errorCorrectionLevel:" + errorCorrectionLevel;
          }
          var length = rsBlock.length / 3;
          var list = [];
          for (var i = 0; i < length; i += 1) {
            var count = rsBlock[i * 3 + 0];
            var totalCount = rsBlock[i * 3 + 1];
            var dataCount = rsBlock[i * 3 + 2];
            for (var j = 0; j < count; j += 1) {
              list.push(qrRSBlock(totalCount, dataCount));
            }
          }
          return list;
        };
        return _this;
      })();
      var qrBitBuffer = function() {
        var _buffer = [];
        var _length = 0;
        var _this = {};
        _this.getBuffer = function() {
          return _buffer;
        };
        _this.getAt = function(index) {
          var bufIndex = Math.floor(index / 8);
          return (_buffer[bufIndex] >>> 7 - index % 8 & 1) == 1;
        };
        _this.put = function(num, length) {
          for (var i = 0; i < length; i += 1) {
            _this.putBit((num >>> length - i - 1 & 1) == 1);
          }
        };
        _this.getLengthInBits = function() {
          return _length;
        };
        _this.putBit = function(bit) {
          var bufIndex = Math.floor(_length / 8);
          if (_buffer.length <= bufIndex) {
            _buffer.push(0);
          }
          if (bit) {
            _buffer[bufIndex] |= 128 >>> _length % 8;
          }
          _length += 1;
        };
        return _this;
      };
      var qrNumber = function(data) {
        var _mode = QRMode.MODE_NUMBER;
        var _data = data;
        var _this = {};
        _this.getMode = function() {
          return _mode;
        };
        _this.getLength = function(buffer) {
          return _data.length;
        };
        _this.write = function(buffer) {
          var data2 = _data;
          var i = 0;
          while (i + 2 < data2.length) {
            buffer.put(strToNum(data2.substring(i, i + 3)), 10);
            i += 3;
          }
          if (i < data2.length) {
            if (data2.length - i == 1) {
              buffer.put(strToNum(data2.substring(i, i + 1)), 4);
            } else if (data2.length - i == 2) {
              buffer.put(strToNum(data2.substring(i, i + 2)), 7);
            }
          }
        };
        var strToNum = function(s) {
          var num = 0;
          for (var i = 0; i < s.length; i += 1) {
            num = num * 10 + chatToNum(s.charAt(i));
          }
          return num;
        };
        var chatToNum = function(c) {
          if ("0" <= c && c <= "9") {
            return c.charCodeAt(0) - "0".charCodeAt(0);
          }
          throw "illegal char :" + c;
        };
        return _this;
      };
      var qrAlphaNum = function(data) {
        var _mode = QRMode.MODE_ALPHA_NUM;
        var _data = data;
        var _this = {};
        _this.getMode = function() {
          return _mode;
        };
        _this.getLength = function(buffer) {
          return _data.length;
        };
        _this.write = function(buffer) {
          var s = _data;
          var i = 0;
          while (i + 1 < s.length) {
            buffer.put(
              getCode(s.charAt(i)) * 45 + getCode(s.charAt(i + 1)),
              11
            );
            i += 2;
          }
          if (i < s.length) {
            buffer.put(getCode(s.charAt(i)), 6);
          }
        };
        var getCode = function(c) {
          if ("0" <= c && c <= "9") {
            return c.charCodeAt(0) - "0".charCodeAt(0);
          } else if ("A" <= c && c <= "Z") {
            return c.charCodeAt(0) - "A".charCodeAt(0) + 10;
          } else {
            switch (c) {
              case " ":
                return 36;
              case "$":
                return 37;
              case "%":
                return 38;
              case "*":
                return 39;
              case "+":
                return 40;
              case "-":
                return 41;
              case ".":
                return 42;
              case "/":
                return 43;
              case ":":
                return 44;
              default:
                throw "illegal char :" + c;
            }
          }
        };
        return _this;
      };
      var qr8BitByte = function(data) {
        var _mode = QRMode.MODE_8BIT_BYTE;
        var _data = data;
        var _bytes = qrcode3.stringToBytes(data);
        var _this = {};
        _this.getMode = function() {
          return _mode;
        };
        _this.getLength = function(buffer) {
          return _bytes.length;
        };
        _this.write = function(buffer) {
          for (var i = 0; i < _bytes.length; i += 1) {
            buffer.put(_bytes[i], 8);
          }
        };
        return _this;
      };
      var qrKanji = function(data) {
        var _mode = QRMode.MODE_KANJI;
        var _data = data;
        var stringToBytes = qrcode3.stringToBytesFuncs["SJIS"];
        if (!stringToBytes) {
          throw "sjis not supported.";
        }
        !(function(c, code) {
          var test = stringToBytes(c);
          if (test.length != 2 || (test[0] << 8 | test[1]) != code) {
            throw "sjis not supported.";
          }
        })("\u53CB", 38726);
        var _bytes = stringToBytes(data);
        var _this = {};
        _this.getMode = function() {
          return _mode;
        };
        _this.getLength = function(buffer) {
          return ~~(_bytes.length / 2);
        };
        _this.write = function(buffer) {
          var data2 = _bytes;
          var i = 0;
          while (i + 1 < data2.length) {
            var c = (255 & data2[i]) << 8 | 255 & data2[i + 1];
            if (33088 <= c && c <= 40956) {
              c -= 33088;
            } else if (57408 <= c && c <= 60351) {
              c -= 49472;
            } else {
              throw "illegal char at " + (i + 1) + "/" + c;
            }
            c = (c >>> 8 & 255) * 192 + (c & 255);
            buffer.put(c, 13);
            i += 2;
          }
          if (i < data2.length) {
            throw "illegal char at " + (i + 1);
          }
        };
        return _this;
      };
      var byteArrayOutputStream = function() {
        var _bytes = [];
        var _this = {};
        _this.writeByte = function(b) {
          _bytes.push(b & 255);
        };
        _this.writeShort = function(i) {
          _this.writeByte(i);
          _this.writeByte(i >>> 8);
        };
        _this.writeBytes = function(b, off, len) {
          off = off || 0;
          len = len || b.length;
          for (var i = 0; i < len; i += 1) {
            _this.writeByte(b[i + off]);
          }
        };
        _this.writeString = function(s) {
          for (var i = 0; i < s.length; i += 1) {
            _this.writeByte(s.charCodeAt(i));
          }
        };
        _this.toByteArray = function() {
          return _bytes;
        };
        _this.toString = function() {
          var s = "";
          s += "[";
          for (var i = 0; i < _bytes.length; i += 1) {
            if (i > 0) {
              s += ",";
            }
            s += _bytes[i];
          }
          s += "]";
          return s;
        };
        return _this;
      };
      var base64EncodeOutputStream = function() {
        var _buffer = 0;
        var _buflen = 0;
        var _length = 0;
        var _base64 = "";
        var _this = {};
        var writeEncoded = function(b) {
          _base64 += String.fromCharCode(encode(b & 63));
        };
        var encode = function(n) {
          if (n < 0) {
          } else if (n < 26) {
            return 65 + n;
          } else if (n < 52) {
            return 97 + (n - 26);
          } else if (n < 62) {
            return 48 + (n - 52);
          } else if (n == 62) {
            return 43;
          } else if (n == 63) {
            return 47;
          }
          throw "n:" + n;
        };
        _this.writeByte = function(n) {
          _buffer = _buffer << 8 | n & 255;
          _buflen += 8;
          _length += 1;
          while (_buflen >= 6) {
            writeEncoded(_buffer >>> _buflen - 6);
            _buflen -= 6;
          }
        };
        _this.flush = function() {
          if (_buflen > 0) {
            writeEncoded(_buffer << 6 - _buflen);
            _buffer = 0;
            _buflen = 0;
          }
          if (_length % 3 != 0) {
            var padlen = 3 - _length % 3;
            for (var i = 0; i < padlen; i += 1) {
              _base64 += "=";
            }
          }
        };
        _this.toString = function() {
          return _base64;
        };
        return _this;
      };
      var base64DecodeInputStream = function(str) {
        var _str = str;
        var _pos = 0;
        var _buffer = 0;
        var _buflen = 0;
        var _this = {};
        _this.read = function() {
          while (_buflen < 8) {
            if (_pos >= _str.length) {
              if (_buflen == 0) {
                return -1;
              }
              throw "unexpected end of file./" + _buflen;
            }
            var c = _str.charAt(_pos);
            _pos += 1;
            if (c == "=") {
              _buflen = 0;
              return -1;
            } else if (c.match(/^\s$/)) {
              continue;
            }
            _buffer = _buffer << 6 | decode(c.charCodeAt(0));
            _buflen += 6;
          }
          var n = _buffer >>> _buflen - 8 & 255;
          _buflen -= 8;
          return n;
        };
        var decode = function(c) {
          if (65 <= c && c <= 90) {
            return c - 65;
          } else if (97 <= c && c <= 122) {
            return c - 97 + 26;
          } else if (48 <= c && c <= 57) {
            return c - 48 + 52;
          } else if (c == 43) {
            return 62;
          } else if (c == 47) {
            return 63;
          } else {
            throw "c:" + c;
          }
        };
        return _this;
      };
      var gifImage = function(width, height) {
        var _width = width;
        var _height = height;
        var _data = new Array(width * height);
        var _this = {};
        _this.setPixel = function(x, y, pixel) {
          _data[y * _width + x] = pixel;
        };
        _this.write = function(out) {
          out.writeString("GIF87a");
          out.writeShort(_width);
          out.writeShort(_height);
          out.writeByte(128);
          out.writeByte(0);
          out.writeByte(0);
          out.writeByte(0);
          out.writeByte(0);
          out.writeByte(0);
          out.writeByte(255);
          out.writeByte(255);
          out.writeByte(255);
          out.writeString(",");
          out.writeShort(0);
          out.writeShort(0);
          out.writeShort(_width);
          out.writeShort(_height);
          out.writeByte(0);
          var lzwMinCodeSize = 2;
          var raster = getLZWRaster(lzwMinCodeSize);
          out.writeByte(lzwMinCodeSize);
          var offset = 0;
          while (raster.length - offset > 255) {
            out.writeByte(255);
            out.writeBytes(raster, offset, 255);
            offset += 255;
          }
          out.writeByte(raster.length - offset);
          out.writeBytes(raster, offset, raster.length - offset);
          out.writeByte(0);
          out.writeString(";");
        };
        var bitOutputStream = function(out) {
          var _out = out;
          var _bitLength = 0;
          var _bitBuffer = 0;
          var _this2 = {};
          _this2.write = function(data, length) {
            if (data >>> length != 0) {
              throw "length over";
            }
            while (_bitLength + length >= 8) {
              _out.writeByte(255 & (data << _bitLength | _bitBuffer));
              length -= 8 - _bitLength;
              data >>>= 8 - _bitLength;
              _bitBuffer = 0;
              _bitLength = 0;
            }
            _bitBuffer = data << _bitLength | _bitBuffer;
            _bitLength = _bitLength + length;
          };
          _this2.flush = function() {
            if (_bitLength > 0) {
              _out.writeByte(_bitBuffer);
            }
          };
          return _this2;
        };
        var getLZWRaster = function(lzwMinCodeSize) {
          var clearCode = 1 << lzwMinCodeSize;
          var endCode = (1 << lzwMinCodeSize) + 1;
          var bitLength = lzwMinCodeSize + 1;
          var table = lzwTable();
          for (var i = 0; i < clearCode; i += 1) {
            table.add(String.fromCharCode(i));
          }
          table.add(String.fromCharCode(clearCode));
          table.add(String.fromCharCode(endCode));
          var byteOut = byteArrayOutputStream();
          var bitOut = bitOutputStream(byteOut);
          bitOut.write(clearCode, bitLength);
          var dataIndex = 0;
          var s = String.fromCharCode(_data[dataIndex]);
          dataIndex += 1;
          while (dataIndex < _data.length) {
            var c = String.fromCharCode(_data[dataIndex]);
            dataIndex += 1;
            if (table.contains(s + c)) {
              s = s + c;
            } else {
              bitOut.write(table.indexOf(s), bitLength);
              if (table.size() < 4095) {
                if (table.size() == 1 << bitLength) {
                  bitLength += 1;
                }
                table.add(s + c);
              }
              s = c;
            }
          }
          bitOut.write(table.indexOf(s), bitLength);
          bitOut.write(endCode, bitLength);
          bitOut.flush();
          return byteOut.toByteArray();
        };
        var lzwTable = function() {
          var _map = {};
          var _size = 0;
          var _this2 = {};
          _this2.add = function(key) {
            if (_this2.contains(key)) {
              throw "dup key:" + key;
            }
            _map[key] = _size;
            _size += 1;
          };
          _this2.size = function() {
            return _size;
          };
          _this2.indexOf = function(key) {
            return _map[key];
          };
          _this2.contains = function(key) {
            return typeof _map[key] != "undefined";
          };
          return _this2;
        };
        return _this;
      };
      var createDataURL = function(width, height, getPixel) {
        var gif = gifImage(width, height);
        for (var y = 0; y < height; y += 1) {
          for (var x = 0; x < width; x += 1) {
            gif.setPixel(x, y, getPixel(x, y));
          }
        }
        var b = byteArrayOutputStream();
        gif.write(b);
        var base64 = base64EncodeOutputStream();
        var bytes = b.toByteArray();
        for (var i = 0; i < bytes.length; i += 1) {
          base64.writeByte(bytes[i]);
        }
        base64.flush();
        return "data:image/gif;base64," + base64;
      };
      return qrcode3;
    })();
    !(function() {
      qrcode2.stringToBytesFuncs["UTF-8"] = function(s) {
        function toUTF8Array(str) {
          var utf8 = [];
          for (var i = 0; i < str.length; i++) {
            var charcode = str.charCodeAt(i);
            if (charcode < 128) utf8.push(charcode);
            else if (charcode < 2048) {
              utf8.push(
                192 | charcode >> 6,
                128 | charcode & 63
              );
            } else if (charcode < 55296 || charcode >= 57344) {
              utf8.push(
                224 | charcode >> 12,
                128 | charcode >> 6 & 63,
                128 | charcode & 63
              );
            } else {
              i++;
              charcode = 65536 + ((charcode & 1023) << 10 | str.charCodeAt(i) & 1023);
              utf8.push(
                240 | charcode >> 18,
                128 | charcode >> 12 & 63,
                128 | charcode >> 6 & 63,
                128 | charcode & 63
              );
            }
          }
          return utf8;
        }
        return toUTF8Array(s);
      };
    })();
    (function(factory) {
      if (typeof define === "function" && define.amd) {
        define([], factory);
      } else if (typeof exports === "object") {
        module2.exports = factory();
      }
    })(function() {
      return qrcode2;
    });
  }
});

// telegram-client/src/plugin.ts
var plugin_exports = {};
__export(plugin_exports, {
  default: () => plugin_default
});
module.exports = __toCommonJS(plugin_exports);

// telegram-client/src/qr.ts
var import_qrcode_generator = __toESM(require_qrcode(), 1);
var QUIET_ZONE = 4;
var PIXELS_PER_MODULE = 6;
function qrSvg(text) {
  const qr = (0, import_qrcode_generator.default)(0, "M");
  qr.addData(text, "Byte");
  qr.make();
  const count = qr.getModuleCount();
  const size = count + QUIET_ZONE * 2;
  let path = "";
  for (let row = 0; row < count; row++) {
    let col = 0;
    while (col < count) {
      if (!qr.isDark(row, col)) {
        col++;
        continue;
      }
      const start = col;
      while (col < count && qr.isDark(row, col)) col++;
      path += `M${start + QUIET_ZONE} ${row + QUIET_ZONE}h${col - start}v1h-${col - start}z`;
    }
  }
  const pixels = size * PIXELS_PER_MODULE;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${pixels}" height="${pixels}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}

// telegram-client/src/plugin.ts
var VERSION = "0.11.0";
var ROOT = "~/.codeterm/telegram-client";
var BUNDLE = "~/.codeterm/plugins/telegram-client";
var CONFIG_NAME = "gotd.cli.yaml";
var SCAN_MESSAGE = "Render qrSvg in chat as a scannable QR and show tgLink as text. Scan it in Telegram Settings \u2192 Devices \u2192 Link Desktop Device, then poll login-status.";
var INITIAL_SEND_POLICY_MODE = "saved-messages-only";
var MAX_COUNT = 50;
var MAX_BYTES = 32 * 1024;
var loginJobs = {};
var loginPasswords = {};
var loginLaunchPending = {};
var loginLogPaths = {};
var activeLoginJobId = null;
var previewTokens = {};
var injectedClock = null;
var transientSendFailure = null;
function platformName() {
  try {
    return String(host.platform() || "").toLowerCase();
  } catch {
    return "";
  }
}
function binaryName() {
  return host.path.isWindows ? "tg.exe" : "tg";
}
function nativePath(value) {
  return host.path.toNative(host.path.normalize(value));
}
function childPath(root, name) {
  const child = nativePath(`${root}/${name}`);
  if (host.path.equal(child, root)) throw new Error("plugin data path resolved to its root");
  return child;
}
function paths() {
  try {
    const expanded = host.fs.expandHome(ROOT);
    const root = expanded ? nativePath(expanded) : "";
    if (!root) return null;
    return {
      root,
      binDir: childPath(root, "bin"),
      binary: childPath(childPath(root, "bin"), binaryName()),
      config: childPath(root, CONFIG_NAME),
      install: childPath(root, "install.json"),
      failure: childPath(root, "install-status.json"),
      outbox: childPath(root, "outbox.json"),
      policy: childPath(root, "send-policy.json")
    };
  } catch {
    return null;
  }
}
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
function redact(text) {
  let out = text || "";
  for (const key of ["api_id", "api_hash"]) {
    let value = "";
    try {
      value = host.secretGet(key) || "";
    } catch {
      value = "";
    }
    if (value) out = out.split(value).join("[redacted]");
  }
  return out;
}
function telegramLoginArtifacts(text) {
  const safe = redact(String(text || "")).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, " ");
  const match = safe.match(/tg:\/\/login\?token=[A-Za-z0-9_%=-]+/i);
  if (!match) return {};
  const link = match[0].replace(/[),.;]+$/, "");
  let svg;
  try {
    svg = qrSvg(link);
  } catch {
    svg = void 0;
  }
  return { qrPayload: link, tgLink: link, qrSvg: svg };
}
function loginFailure(output) {
  const lines = String(output || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const last = lines[lines.length - 1] || "";
  return /^tg: /.test(last) ? last.slice(4).trim() : null;
}
function rejectedCredentials(failure) {
  return /\b(API_ID_INVALID|API_HASH_INVALID|API_ID_PUBLISHED_FLOOD)\b/.test(failure);
}
function loginFailureMessage(failure) {
  return rejectedCredentials(failure) ? `Telegram rejected the API ID and hash (${failure.match(/API_[A-Z_]+/)?.[0]}). Check them at https://my.telegram.org, store the corrected values with --secret api_id and --secret api_hash, then run login again.` : `tg login failed: ${failure}`;
}
function resetRejectedConfig(p, label) {
  const entries = host.fs.readDir(p.root) || [];
  const prefix = new RegExp(`^gotd\\.(session|peers)\\.${label}\\.`);
  for (const entry of entries) if (prefix.test(entry.name)) host.fs.removeFile(entry.path);
  host.fs.removeFile(p.config);
  try {
    host.secretDelete("config_initialized");
  } catch {
  }
}
function installCommand(p) {
  let bundle = null;
  try {
    bundle = host.fs.expandHome(BUNDLE);
  } catch {
    bundle = null;
  }
  const script = bundle ? childPath(childPath(nativePath(bundle), "scripts"), "install-tg.cjs") : "telegram-client/scripts/install-tg.cjs";
  return `node "${script}" --root "${p.root}"`;
}
function notInstalledMessage(p) {
  if (!p) return "The host home directory is unavailable.";
  return `tg is not installed in ${p.root}. Install the pinned release with: ${installCommand(p)}`;
}
function safeError(run) {
  if (run.ok) return "";
  const detail = redact(run.error || run.stderr || "tg command failed").trim();
  return detail.slice(0, 600) || "tg command failed";
}
function options(args, env, extra) {
  const p = paths();
  if (!p || !host.fs.fileExists(p.binary)) return null;
  const full = ["--config", p.config].concat(args);
  return { bin: p.binary, args: full, env: env || {}, ...extra || {} };
}
function startTg(args, env, extra) {
  const opts = options(args, env, extra);
  if (!opts) return { error: notInstalledMessage(paths()) };
  try {
    const started = host.exec.start(opts);
    if (!started || !started.jobId && !started.error) return { error: "tg start returned no job identifier.", ambiguousStart: true };
    return started;
  } catch {
    return { error: "Could not confirm whether tg started.", ambiguousStart: true };
  }
}
function runTg(args, env) {
  const opts = options(args, env, { timeoutMs: 4500 });
  if (!opts) return { ok: false, error: notInstalledMessage(paths()), stderr: "" };
  const raw = host.exec(JSON.stringify(opts));
  const result = parseJson(raw);
  if (!result) return { ok: false, error: "tg returned an unreadable process result.", stderr: "" };
  const stdout = redact(result.stdout || "");
  const stderr = redact(result.stderr || "");
  if (result.error) return { ok: false, error: redact(result.error), stderr };
  if (result.code !== 0) return { ok: false, error: stderr || stdout || `tg exited ${result.code}`, stderr };
  return { ok: true, stdout, stderr };
}
function jsonCommand(args) {
  const run = runTg(["--output", "json"].concat(args));
  if (!run.ok) return { error: safeError(run), stderr: run.stderr };
  const parsed = parseJson(run.stdout.trim());
  if (!parsed || parsed.schema !== 1 || parsed.data === void 0) {
    return { error: "tg returned an unreadable JSON response." };
  }
  return { data: parsed.data, stderr: run.stderr };
}
function settings() {
  let value = {};
  try {
    value = parseJson(host.settingsJson()) || {};
  } catch {
    value = {};
  }
  const count = Number(value.historyCount);
  const bytes = Number(value.historyMaxBytes);
  return {
    historyCount: Number.isInteger(count) ? Math.max(1, Math.min(MAX_COUNT, count)) : 20,
    historyMaxBytes: Number.isInteger(bytes) ? Math.max(1024, Math.min(MAX_BYTES, bytes)) : MAX_BYTES
  };
}
function utf8Bytes(text) {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 128) bytes += 1;
    else if (c < 2048) bytes += 2;
    else if (c >= 55296 && c <= 56319 && i + 1 < text.length) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}
function now() {
  const value = injectedClock ? Number(injectedClock()) : Date.now();
  return Number.isFinite(value) ? value : Date.now();
}
function sha256Hex(text) {
  const bytes = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 55296 && code <= 56319 && i + 1 < text.length) {
      const low2 = text.charCodeAt(i + 1);
      if (low2 >= 56320 && low2 <= 57343) {
        code = 65536 + (code - 55296 << 10) + (low2 - 56320);
        i++;
      } else code = 65533;
    } else if (code >= 56320 && code <= 57343) code = 65533;
    if (code < 128) bytes.push(code);
    else if (code < 2048) bytes.push(192 | code >> 6, 128 | code & 63);
    else if (code < 65536) bytes.push(224 | code >> 12, 128 | code >> 6 & 63, 128 | code & 63);
    else bytes.push(240 | code >> 18, 128 | code >> 12 & 63, 128 | code >> 6 & 63, 128 | code & 63);
  }
  const bitLength = bytes.length * 8;
  bytes.push(128);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const high = Math.floor(bitLength / 4294967296);
  const low = bitLength >>> 0;
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push(high >>> shift & 255);
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push(low >>> shift & 255);
  const constants = [
    1116352408,
    1899447441,
    3049323471,
    3921009573,
    961987163,
    1508970993,
    2453635748,
    2870763221,
    3624381080,
    310598401,
    607225278,
    1426881987,
    1925078388,
    2162078206,
    2614888103,
    3248222580,
    3835390401,
    4022224774,
    264347078,
    604807628,
    770255983,
    1249150122,
    1555081692,
    1996064986,
    2554220882,
    2821834349,
    2952996808,
    3210313671,
    3336571891,
    3584528711,
    113926993,
    338241895,
    666307205,
    773529912,
    1294757372,
    1396182291,
    1695183700,
    1986661051,
    2177026350,
    2456956037,
    2730485921,
    2820302411,
    3259730800,
    3345764771,
    3516065817,
    3600352804,
    4094571909,
    275423344,
    430227734,
    506948616,
    659060556,
    883997877,
    958139571,
    1322822218,
    1537002063,
    1747873779,
    1955562222,
    2024104815,
    2227730452,
    2361852424,
    2428436474,
    2756734187,
    3204031479,
    3329325298
  ];
  const state = [1779033703, 3144134277, 1013904242, 2773480762, 1359893119, 2600822924, 528734635, 1541459225];
  const words = new Array(64);
  const rotate = (value, bits) => value >>> bits | value << 32 - bits;
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let i = 0; i < 16; i++) {
      const at = offset + i * 4;
      words[i] = (bytes[at] << 24 | bytes[at + 1] << 16 | bytes[at + 2] << 8 | bytes[at + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const x = words[i - 15];
      const y = words[i - 2];
      const s0 = rotate(x, 7) ^ rotate(x, 18) ^ x >>> 3;
      const s1 = rotate(y, 17) ^ rotate(y, 19) ^ y >>> 10;
      words[i] = words[i - 16] + s0 + words[i - 7] + s1 >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let i = 0; i < 64; i++) {
      const sum1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      const choice = e & f ^ ~e & g;
      const t1 = h + sum1 + choice + constants[i] + words[i] >>> 0;
      const sum0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      const majority = a & b ^ a & c ^ b & c;
      const t2 = sum0 + majority >>> 0;
      h = g;
      g = f;
      f = e;
      e = d + t1 >>> 0;
      d = c;
      c = b;
      b = a;
      a = t1 + t2 >>> 0;
    }
    state[0] = state[0] + a >>> 0;
    state[1] = state[1] + b >>> 0;
    state[2] = state[2] + c >>> 0;
    state[3] = state[3] + d >>> 0;
    state[4] = state[4] + e >>> 0;
    state[5] = state[5] + f >>> 0;
    state[6] = state[6] + g >>> 0;
    state[7] = state[7] + h >>> 0;
  }
  return state.map((value) => value.toString(16).padStart(8, "0")).join("");
}
function cutText(text, units) {
  let end = Math.max(0, Math.min(text.length, units));
  if (end > 0 && end < text.length) {
    const c = text.charCodeAt(end - 1);
    const next = text.charCodeAt(end);
    if (c >= 55296 && c <= 56319 && next >= 56320 && next <= 57343) end--;
  }
  return text.slice(0, end);
}
function boundedHistory(chatId2, source, count, maxBytes) {
  const out = { chatId: chatId2, messages: [], truncated: false };
  for (const raw of (Array.isArray(source) ? source : []).slice(-count)) {
    const msg = {
      id: Number.isFinite(Number(raw && raw.id)) ? Number(raw.id) : null,
      date: Number.isFinite(Number(raw && raw.date)) ? Number(raw.date) : null,
      out: !!(raw && raw.out)
    };
    if (raw && typeof raw.text === "string") msg.text = raw.text;
    if (raw && Number.isFinite(Number(raw.reply_to))) msg.replyTo = Number(raw.reply_to);
    const before = out.messages.length;
    out.messages.push(msg);
    let json2 = JSON.stringify(out);
    if (utf8Bytes(json2) <= maxBytes) continue;
    out.messages.pop();
    const text = typeof msg.text === "string" ? msg.text : "";
    let low = 0;
    let high = text.length;
    let best = "";
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candidate = { ...msg, text: cutText(text, mid) };
      out.messages.push(candidate);
      json2 = JSON.stringify(out);
      out.messages.pop();
      if (utf8Bytes(json2) <= maxBytes) {
        best = candidate.text;
        low = mid + 1;
      } else high = mid - 1;
    }
    if (best || utf8Bytes(JSON.stringify({ ...out, messages: out.messages.concat([{ id: msg.id, date: msg.date, out: msg.out }]) })) <= maxBytes) {
      if (best) msg.text = best;
      else delete msg.text;
      out.messages.push(msg);
      out.truncated = true;
      if (before >= count) break;
      continue;
    }
    out.truncated = true;
    break;
  }
  const json = JSON.stringify(out);
  return { value: out, json: utf8Bytes(json) <= maxBytes ? json : JSON.stringify({ chatId: chatId2, messages: [], truncated: true }) };
}
function validChatId(value) {
  return /^id:-?[0-9]{1,20}$/.test(value);
}
function chatId(peer) {
  if (!peer || typeof peer.id !== "number" && typeof peer.id !== "string") return null;
  if (typeof peer.id === "number" && !Number.isSafeInteger(peer.id)) return null;
  const id = String(peer.id);
  return /^-?[0-9]{1,20}$/.test(id) ? `id:${id}` : null;
}
function agentAccounts() {
  const response = jsonCommand(["accounts"]);
  if (response.error) return { error: response.error };
  const accounts = Array.isArray(response.data.accounts) ? response.data.accounts : [];
  return { result: JSON.stringify({ accounts: accounts.map((a) => ({
    id: String(a.label || ""),
    label: String(a.label || ""),
    hasSession: !!a.has_session,
    current: !!a.default
  })) }) };
}
function accountLabels() {
  const response = jsonCommand(["accounts"]);
  if (response.error) return { labels: [], current: null, error: response.error };
  const accounts = Array.isArray(response.data.accounts) ? response.data.accounts : [];
  return {
    labels: accounts.map((a) => String(a.label || "")).filter(Boolean),
    current: (accounts.find((a) => a.default) || {}).label || null
  };
}
function useAccount(label) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(label) || label === "all") return { error: "Use a configured account label." };
  const current = accountLabels();
  if (current.error) return { error: current.error };
  if (current.labels.indexOf(label) < 0) return { error: "That account is not configured. Open the Telegram view to add it." };
  const run = runTg(["accounts", "default", label]);
  if (!run.ok) return { error: safeError(run) };
  return { result: JSON.stringify({ currentAccount: label }) };
}
function agentChats() {
  const response = jsonCommand(["chats", "list", "--limit", "100"]);
  if (response.error) return { error: response.error };
  const source = Array.isArray(response.data.chats) ? response.data.chats : [];
  const chats = source.flatMap((item) => {
    const id = chatId(item && item.peer);
    if (!id) return [];
    return [{ id, title: String(item.peer && (item.peer.label || item.peer.title) || ""), unread: Number(item.unread) || 0 }];
  });
  return { result: JSON.stringify({ chats }) };
}
function policySummary() {
  const p = paths();
  if (!p) return { configured: false, mode: null, allowedDestinations: [] };
  let policy = null;
  try {
    policy = host.fs.readJson(p.policy);
  } catch {
    policy = null;
  }
  if (!policy || policy.approved !== true || policy.mode !== INITIAL_SEND_POLICY_MODE || !/^[A-Za-z0-9_-]{1,64}$/.test(String(policy.senderAccountId || "")) || !validChatId(String(policy.savedMessagesId || ""))) {
    return { configured: false, mode: null, allowedDestinations: [] };
  }
  return {
    configured: true,
    mode: "saved-messages-only",
    senderAccountId: String(policy.senderAccountId || ""),
    allowedDestinations: [{ id: String(policy.savedMessagesId), label: "Saved Messages" }],
    approvedAt: Number(policy.approvedAt) || null
  };
}
function resolveSender() {
  const current = status();
  if (current.state === "reauth-needed") return { error: "reauth-needed: Open Telegram Client and complete QR login again before previewing or sending." };
  if (current.state === "logged-in" && current.currentAccount && !current.resolvedAccount) {
    return { error: "upstream-rejected: The signed-in sender could not be resolved from Telegram. Restore the connection and refresh status before sending." };
  }
  if (current.state !== "logged-in" || !current.currentAccount || !current.resolvedAccount) {
    return { error: "not-logged-in: Sign in to a Telegram account in Telegram Client, then preview the sender again." };
  }
  const identity = current.resolvedAccount;
  const telegramUserId = identity && Number.isSafeInteger(Number(identity.id)) ? String(Number(identity.id)) : "";
  if (!telegramUserId) return { error: "not-logged-in: Telegram did not resolve a numeric account identity. Refresh status or sign in again." };
  const name = [identity.first_name, identity.last_name].map((part) => String(part || "").trim()).filter(Boolean).join(" ");
  const username = String(identity.username || "").replace(/^@/, "");
  return { sender: {
    id: String(current.currentAccount),
    displayName: name || (username ? `@${username}` : `Telegram user ${telegramUserId}`),
    username: username ? `@${username}` : null,
    telegramUserId
  } };
}
function resolveDestination(id, sender) {
  if (!validChatId(id)) return { error: "Usage: preview <immutable-chat-id> <text>. Select an id such as id:12345 from chats; display names are not accepted." };
  if (id === `id:${sender.telegramUserId}`) {
    return { destination: { id, label: "Saved Messages" } };
  }
  const response = agentChats();
  if ("error" in response) return { error: `Could not resolve destination ${id}: ${response.error}` };
  const chats = parseJson(response.result).chats;
  const match = chats.find((chat) => chat.id === id);
  if (!match) return { error: `No Telegram chat has immutable id ${id}. Refresh chats and select an id from that list.` };
  return { destination: { id: String(match.id), label: String(match.title || match.id) } };
}
var previewSequence = 0;
function previewCommand(args, origin = "agent") {
  if (args.length < 2) return { error: "Usage: preview <immutable-chat-id> <text>." };
  if (!validChatId(args[0])) return { error: "Usage: preview <immutable-chat-id> <text>. Display names are not accepted; choose an id from chats." };
  const text = args.slice(1).join(" ");
  if (!text.length) return { error: "Preview text must not be empty." };
  const resolved = resolveSender();
  if ("error" in resolved) return { error: resolved.error };
  const destination = resolveDestination(args[0], resolved.sender);
  if ("error" in destination) return { error: destination.error };
  const previewId = sha256Hex(`preview\0${now()}\0${++previewSequence}`);
  previewTokens[previewId] = { sender: resolved.sender, destination: destination.destination, text, origin, previewNonce: previewId };
  return { result: JSON.stringify({
    previewId,
    sender: resolved.sender,
    destination: destination.destination,
    text,
    policy: policySummary()
  }) };
}
function failureMessage(kind, detail) {
  switch (kind) {
    case "not-logged-in":
      return "not-logged-in: Sign in to Telegram Client and confirm the sender account, then preview and send again.";
    case "reauth-needed":
      return "reauth-needed: Telegram authorization expired or was revoked. Complete QR login in Telegram Client before sending again.";
    case "policy-not-set":
      return "policy-not-set: Review the resolved sender and Saved Messages destination in Telegram Client, then explicitly enable the Saved-Messages-only policy.";
    case "destination-not-permitted":
      return `destination-not-permitted: This destination is outside the Saved-Messages-only policy. Its permitted immutable id is ${String(detail || "unavailable")}. Select that exact id or have the owner review a different policy.`;
    case "rate-limited":
      return `rate-limited: Telegram asked this account to wait until ${Number(detail) || 0}. Invoke send again after that deadline; the plugin will not wait or retry automatically.`;
    case "upstream-rejected":
      return `upstream-rejected: Telegram rejected the request or the local send prerequisite failed (${String(detail || "no further detail")}). Correct the reported issue, then invoke send again if you still want it delivered.`;
    case "unknown":
      return "unknown: Telegram may have accepted this message but the confirmation was lost. Do not retry this idempotency key; inspect Saved Messages and decide manually.";
  }
  return "upstream-rejected: The send failure state was not recognized. Inspect Telegram Client status before trying again.";
}
function setSendPolicy(args) {
  if (args.approveSavedMessagesOnly !== true) return { error: "No send policy was changed. Use the explicit Saved Messages only approval control after reviewing its preview." };
  const preview = previewTokens[String(args.previewId || "")];
  if (!preview || preview.origin !== "view") return { error: "Only a preview created in this view can enable a send policy. Review a fresh view preview first." };
  const expected = `id:${preview.sender.telegramUserId}`;
  if (preview.destination.id !== expected || preview.destination.label !== "Saved Messages") {
    return { error: "The initial send policy can permit only this sender's Saved Messages destination. Preview Saved Messages before approving it." };
  }
  const currentSender = resolveSender();
  if ("error" in currentSender || currentSender.sender.id !== preview.sender.id || currentSender.sender.telegramUserId !== preview.sender.telegramUserId) {
    return { error: "The resolved sender changed or is unavailable. Review a fresh Saved Messages preview before enabling the policy." };
  }
  const p = paths();
  if (!p) return { error: "Could not resolve the Telegram Client data directory; no send policy was written." };
  try {
    if (!host.fs.makeDirs(p.root)) return { error: "Could not create the Telegram Client data directory; no send policy was written." };
    const saved = host.fs.writeFile(p.policy, JSON.stringify({
      approved: true,
      mode: INITIAL_SEND_POLICY_MODE,
      savedMessagesId: preview.destination.id,
      senderAccountId: preview.sender.id,
      approvedAt: now()
    }));
    if (!saved) return { error: "Could not persist the send policy in Telegram Client data; no policy is enabled." };
  } catch {
    return { error: "Could not persist the send policy in Telegram Client data; no policy is enabled." };
  }
  return { result: JSON.stringify(policySummary()) };
}
function loadOutbox(p) {
  try {
    if (!host.fs.fileExists(p.outbox)) return { ledger: { schema: 1, attempts: [] } };
    const value = host.fs.readJson(p.outbox);
    if (!value || value.schema !== 1 || !Array.isArray(value.attempts)) return { error: "the existing outbox ledger is unreadable" };
    return { ledger: value };
  } catch {
    return { error: "the existing outbox ledger could not be read" };
  }
}
function persistOutbox(p, ledger) {
  try {
    if (!host.fs.makeDirs(p.root)) return false;
    return host.fs.writeFile(p.outbox, JSON.stringify(ledger)) === true;
  } catch {
    return false;
  }
}
function rememberSendFailure(kind, message) {
  transientSendFailure = { state: kind, message, updatedAt: now() };
  return { error: message };
}
function sendFailureResult(kind, detail) {
  return rememberSendFailure(kind, failureMessage(kind, detail));
}
function rememberPrefixedFailure(message) {
  const state = message.slice(0, message.indexOf(":"));
  const allowed = ["not-logged-in", "reauth-needed", "policy-not-set", "destination-not-permitted", "rate-limited", "upstream-rejected", "unknown"];
  return allowed.indexOf(state) >= 0 ? rememberSendFailure(state, message) : rememberSendFailure("unknown", "The command result could not be classified safely. Inspect Telegram before retrying.");
}
function parseSendArgs(args) {
  if (args.length < 2 || !validChatId(args[0])) return { error: "destination-not-permitted: Usage: send <immutable-chat-id> [--key <idempotency-key>] <text>. Choose an id from chats; display names are not accepted." };
  let start = 1;
  let key;
  if (args[1] === "--key") {
    if (args.length < 4 || !/^[A-Za-z0-9._:-]{1,160}$/.test(args[2])) return { error: "upstream-rejected: --key needs a 1\u2013160 character idempotency key, followed by message text." };
    key = args[2];
    start = 3;
  }
  const text = args.slice(start).join(" ");
  if (!text.length) return { error: "upstream-rejected: Message text must not be empty." };
  return { chatId: args[0], text, key };
}
function failureForUpstream(message) {
  if (authFailure(message)) return "reauth-needed";
  if (/not logged in|no active session|run tg login/i.test(message)) return "not-logged-in";
  if (waitSeconds(message) !== null) return "rate-limited";
  if (/MESSAGE_TOO_LONG|PEER_ID_INVALID|CHAT_WRITE_FORBIDDEN|USER_BANNED_IN_CHANNEL|USER_PRIVACY_RESTRICTED|CHAT_ADMIN_REQUIRED|WRITE_FORBIDDEN/i.test(message)) return "upstream-rejected";
  if (/exec denied|spawn .*?(?:ENOENT|EACCES)|binary .*?not found|not installed/i.test(message)) return "upstream-rejected";
  return "unknown";
}
function waitSeconds(message) {
  const match = message.match(/FLOOD_WAIT_(\d+)/i) || message.match(/wait of\s+(\d+)\s+seconds/i);
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}
function attemptResult(attempt) {
  transientSendFailure = null;
  return { result: JSON.stringify({
    status: "sent",
    sender: attempt.sender,
    destination: attempt.destination,
    idempotencyKey: attempt.idempotencyKey,
    telegramMessageId: attempt.telegramMessageId || null,
    deliveryGuarantee: "The local ledger prevents another send for a recorded sent key. Telegram does not provide an exactly-once delivery guarantee."
  }) };
}
function failAttempt(p, ledger, attempt, kind, detail) {
  attempt.failure = kind;
  attempt.failureMessage = failureMessage(kind, detail);
  attempt.updatedAt = now();
  if (kind === "rate-limited") {
    const seconds = waitSeconds(String(detail || ""));
    if (seconds === null) return failAttempt(p, ledger, attempt, "upstream-rejected", "Telegram returned a rate-limit message without a retry duration; check Telegram before retrying");
    attempt.state = "rate_limited";
    attempt.retryAfter = now() + seconds * 1e3;
    attempt.failureMessage = failureMessage(kind, attempt.retryAfter);
  } else if (kind === "unknown") {
    attempt.state = "unknown";
    delete attempt.retryAfter;
  } else {
    attempt.state = "failed";
    delete attempt.retryAfter;
  }
  persistOutbox(p, ledger);
  return rememberSendFailure(kind, attempt.failureMessage);
}
function recordedByCallerKey(key, chatId2, text) {
  const p = paths();
  if (!p) return sendFailureResult("upstream-rejected", "the plugin-owned data directory is unavailable");
  const loaded = loadOutbox(p);
  if (!loaded.ledger) return sendFailureResult("upstream-rejected", loaded.error);
  const attempt = loaded.ledger.attempts.find((item) => item.idempotencyKey === key);
  if (!attempt) return null;
  if (attempt.payloadHash !== sha256Hex(text) || attempt.destination.id !== chatId2) {
    return sendFailureResult("upstream-rejected", "this idempotency key is already bound to a different destination or payload; choose a new key");
  }
  if (attempt.state === "sent") return attemptResult(attempt);
  if (attempt.state === "unknown") return sendFailureResult("unknown");
  if (attempt.state === "pending") return failAttempt(p, loaded.ledger, attempt, "unknown", "a prior invocation ended while its send result was unrecorded");
  if (attempt.state === "rate_limited" && Number(attempt.retryAfter) > now()) return sendFailureResult("rate-limited", attempt.retryAfter);
  return null;
}
function sendCommand(sessionId, args) {
  const parsed = parseSendArgs(args);
  if ("error" in parsed) return rememberPrefixedFailure(parsed.error);
  const matchingPreview = Object.values(previewTokens).reverse().find((token) => token.sender.id === policySummary().senderAccountId && token.destination.id === parsed.chatId && token.text === parsed.text);
  const key = parsed.key || matchingPreview?.previewNonce;
  if (key) {
    const recorded = recordedByCallerKey(key, parsed.chatId, parsed.text);
    if (recorded) return recorded;
  }
  const policy = policySummary();
  if (!policy.configured) return sendFailureResult("policy-not-set");
  const resolved = resolveSender();
  if ("error" in resolved) return rememberPrefixedFailure(resolved.error);
  const found = resolveDestination(parsed.chatId, resolved.sender);
  if ("error" in found) return sendFailureResult("destination-not-permitted", policy.allowedDestinations[0] && policy.allowedDestinations[0].id);
  const permitted = policy.senderAccountId === resolved.sender.id && policy.allowedDestinations.some((entry) => entry.id === found.destination.id && found.destination.label === "Saved Messages");
  if (!permitted || found.destination.id !== `id:${resolved.sender.telegramUserId}`) return sendFailureResult("destination-not-permitted", policy.allowedDestinations[0] && policy.allowedDestinations[0].id);
  if (!key) return sendFailureResult("upstream-rejected", "create a fresh preview before sending without an explicit idempotency key");
  const payloadHash = sha256Hex(parsed.text);
  const p = paths();
  if (!p) return sendFailureResult("upstream-rejected", "the plugin-owned data directory is unavailable");
  const loaded = loadOutbox(p);
  if (!loaded.ledger) return sendFailureResult("upstream-rejected", loaded.error);
  const ledger = loaded.ledger;
  let attempt = ledger.attempts.find((item) => item.idempotencyKey === key);
  if (attempt && (attempt.payloadHash !== payloadHash || attempt.sender.id !== resolved.sender.id || attempt.destination.id !== found.destination.id)) {
    return sendFailureResult("upstream-rejected", "this idempotency key is already bound to a different sender, destination, or payload; choose a new key");
  }
  if (attempt && attempt.state === "sent") return attemptResult(attempt);
  if (attempt && attempt.state === "unknown") return sendFailureResult("unknown");
  if (attempt && attempt.state === "pending") {
    return failAttempt(p, ledger, attempt, "unknown", "a prior invocation ended while its send result was unrecorded");
  }
  if (attempt && attempt.state === "rate_limited" && Number(attempt.retryAfter) > now()) {
    return sendFailureResult("rate-limited", attempt.retryAfter);
  }
  if (!attempt) {
    attempt = {
      idempotencyKey: key,
      sender: resolved.sender,
      destination: found.destination,
      payloadHash,
      state: "pending",
      createdAt: now(),
      updatedAt: now(),
      sendCount: 0
    };
    ledger.attempts.push(attempt);
  }
  attempt.state = "pending";
  attempt.updatedAt = now();
  attempt.sendCount += 1;
  delete attempt.failure;
  delete attempt.failureMessage;
  delete attempt.retryAfter;
  if (!persistOutbox(p, ledger)) return sendFailureResult("upstream-rejected", "the pending attempt could not be persisted; Telegram was not contacted");
  const opts = options(["--account", resolved.sender.id, "--output", "json", "send", "--", parsed.text], void 0, { timeoutMs: 5e3 });
  if (!opts) return failAttempt(p, ledger, attempt, "upstream-rejected", "tg binary is unavailable before send");
  return host.exec.async(opts, (result) => {
    const output = redact(result.stdout || "");
    const detail = redact(result.error || result.stderr || output).trim();
    if (result.error || typeof result.code !== "number" || result.code !== 0) return failAttempt(p, ledger, attempt, failureForUpstream(detail), detail);
    const response = parseJson(output.trim());
    if (!response || response.schema !== 1 || response.data === void 0) return failAttempt(p, ledger, attempt, "unknown");
    const message = response.data.message || response.data;
    const upstreamId = message && (message.id !== void 0 ? message.id : message.message_id);
    attempt.telegramMessageId = upstreamId === void 0 || upstreamId === null ? void 0 : String(upstreamId);
    attempt.state = "sent";
    attempt.updatedAt = now();
    delete attempt.failure;
    delete attempt.failureMessage;
    if (!persistOutbox(p, ledger)) return sendFailureResult("unknown");
    return attemptResult(attempt);
  });
}
function agentHistory(args) {
  if (args.length < 1 || args.length > 2 || !validChatId(args[0])) return { error: "Usage: history id:<numeric-chat-id> [count]. Select an id from chats." };
  const configured = settings();
  let count = configured.historyCount;
  if (args.length === 2) {
    if (!/^[0-9]+$/.test(args[1])) return { error: "History count must be an integer from 1 to 50." };
    count = Math.max(1, Math.min(MAX_COUNT, Number(args[1])));
  }
  const response = jsonCommand(["history", args[0], "--limit", String(count)]);
  if (response.error) return { error: response.error };
  const history = boundedHistory(args[0], response.data.messages, count, configured.historyMaxBytes);
  return { result: history.json };
}
function authFailure(message) {
  return /not authorized|auth_key_unregistered|session_revoked|session_expired|user_deactivated|authorization key/i.test(message);
}
function storageBackend() {
  const platform = platformName();
  if (platform === "darwin" || platform === "mac" || platform === "macos") return { name: "macOS login Keychain", note: "tg keeps the session in the login Keychain by default." };
  if (host.path.isWindows) return { name: "plugin-owned plaintext file", note: "tg stores the session under this plugin data directory on Windows. This plugin does not inspect or set a Windows ACL, so it makes no ACL protection claim." };
  return { name: "plugin-owned plaintext file", note: "On POSIX hosts tg stores the session in a 0600 file under this plugin's private data directory." };
}
function failureState(p) {
  try {
    const value = host.fs.readJson(p.failure);
    if (value && typeof value.state === "string") return { state: value.state, message: String(value.message || "") };
  } catch {
  }
  return {};
}
function versionOlder(installed, required) {
  const parts = (value) => value.split(".").map((part) => Number(part));
  const left = parts(installed);
  const right = parts(required);
  if (left.some((part) => !Number.isFinite(part)) || right.some((part) => !Number.isFinite(part))) return false;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const a = left[i] || 0;
    const b = right[i] || 0;
    if (a !== b) return a < b;
  }
  return false;
}
function status() {
  const p = paths();
  if (!p) return { state: "unsupported-platform", message: "The host home directory is unavailable.", storage: storageBackend() };
  const storage = storageBackend();
  const failure = failureState(p);
  if (failure.state === "unsupported-platform" || failure.state === "checksum-mismatch") {
    return { state: failure.state, message: failure.message, storage, accounts: [], currentAccount: null };
  }
  const platform = platformName();
  const supportedPlatform = /^(darwin|mac|macos|linux)$/.test(platform) || host.path.isWindows;
  if (!supportedPlatform) {
    return { state: "unsupported-platform", message: `No pinned tg release is available for ${platformName() || "this operating system"}.`, storage, accounts: [], currentAccount: null };
  }
  if (failure.state) return { state: "install-error", message: failure.message || "The pinned tg install did not complete.", storage, accounts: [], currentAccount: null };
  if (!host.fs.fileExists(p.binary)) {
    return { state: "not-installed", message: notInstalledMessage(p), installCommand: installCommand(p), storage, accounts: [], currentAccount: null };
  }
  const install = host.fs.readJson(p.install);
  if (install && install.version && install.version !== VERSION) {
    const state = versionOlder(String(install.version), VERSION) ? "upgrade-available" : "install-error";
    const message = state === "upgrade-available" ? `tg ${VERSION} is pinned; installed metadata reports ${String(install.version)}. Run the installer to upgrade.` : `Installed tg ${String(install.version)} does not match pinned ${VERSION}. Reinstall the pinned release.`;
    return { state, message, storage, accounts: [], currentAccount: null };
  }
  if (host.secretGet("config_initialized") !== "true") {
    const wasConfigured = host.secretGet("configured_once") === "true";
    return {
      state: wasConfigured ? "logged-out" : "installed-but-not-configured",
      message: wasConfigured ? "Signed out. Store your Telegram API ID and hash again, then start QR login." : "Store your own Telegram API ID and hash (secrets api_id and api_hash), then start QR login.",
      storage,
      accounts: [],
      currentAccount: null
    };
  }
  const listed = accountLabels();
  if (listed.error) {
    const state = authFailure(listed.error) ? "reauth-needed" : "logged-out";
    const message = state === "reauth-needed" ? "Telegram needs authorization again. Start QR login again." : "Telegram account config could not be read. Store your own API credentials again, then start QR login.";
    return { state, message, storage, accounts: [], currentAccount: null };
  }
  const result = jsonCommand(["whoami"]);
  const accounts = jsonCommand(["accounts"]);
  const accountRows = accounts.error ? [] : (Array.isArray(accounts.data.accounts) ? accounts.data.accounts : []).map((a) => ({
    id: String(a.label || ""),
    label: String(a.label || ""),
    hasSession: !!a.has_session,
    current: !!a.default
  }));
  const active = accountRows.find((a) => a.current) || null;
  if (result.error) {
    const hasSession = active && active.hasSession;
    const state = authFailure(result.error) ? "reauth-needed" : hasSession ? "logged-in" : "logged-out";
    const message = state === "reauth-needed" ? "The Telegram session expired or was revoked. Start QR login again." : state === "logged-out" ? "No signed-in Telegram session is selected. Start QR login." : "A session is present, but Telegram could not be reached. Refresh status when the connection is available.";
    return { state, message, storage, accounts: accountRows, currentAccount: active && active.label, resolvedAccount: null };
  }
  return {
    state: active && active.hasSession ? "logged-in" : "logged-out",
    message: active && active.hasSession ? "Telegram account resolved." : "No signed-in sender is selected.",
    storage,
    accounts: accountRows,
    currentAccount: active && active.label,
    resolvedAccount: result.data
  };
}
function ensureAccount(label, apiId, apiHash) {
  const p = paths();
  if (!p) return { error: "The host home directory is unavailable." };
  if (!host.fs.fileExists(p.binDir)) return { error: notInstalledMessage(p) };
  let configExists = false;
  try {
    configExists = host.secretGet("config_initialized") === "true";
  } catch {
    configExists = false;
  }
  if (!configExists) {
    const existing = jsonCommand(["accounts"]);
    if (!existing.error) {
      configExists = true;
      try {
        if (!host.secretSet("config_initialized", "true")) return { error: "Could not record Telegram config state in the host secret store." };
      } catch {
        return { error: "Could not record Telegram config state in the host secret store." };
      }
    } else if (!/no config at .*tg init first|run `tg init` first/i.test(existing.error)) {
      return { error: existing.error };
    }
  }
  if (!configExists) {
    const init = runTg(["init"], { APP_ID: apiId, APP_HASH: apiHash });
    if (!init.ok) return { error: safeError(init) };
    try {
      if (!host.secretSet("config_initialized", "true")) return { error: "tg created the config, but CodeTerm could not record its state. Retry login to recover." };
    } catch {
      return { error: "tg created the config, but CodeTerm could not record its state. Retry login to recover." };
    }
  }
  if (label !== "default") {
    const listed = accountLabels();
    if (listed.error) return { error: listed.error };
    if (listed.labels.indexOf(label) < 0) {
      const add = runTg(["accounts", "add", label], { APP_ID: apiId, APP_HASH: apiHash });
      if (!add.ok) return { error: safeError(add) };
    }
  }
  return {};
}
function loginStart(args, fromAgent = false) {
  const p = paths();
  if (!p || !host.fs.fileExists(p.binary)) return { error: notInstalledMessage(p) };
  if (activeLoginJobId && loginJobs[activeLoginJobId]) return { jobId: activeLoginJobId, state: "login-in-progress", message: "Telegram login is already running. Poll its progress for the QR." };
  const apiId = String(fromAgent ? host.secretGet("api_id") || "" : args.apiId || "").trim();
  const apiHash = String(fromAgent ? host.secretGet("api_hash") || "" : args.apiHash || "").trim();
  const label = String(args.accountLabel || "default").trim();
  const twoFactorPassword = String(args.twoFactorPassword || "");
  if (!/^[0-9]{1,12}$/.test(apiId) || !/^[A-Fa-f0-9]{32}$/.test(apiHash)) {
    if (!fromAgent) return { error: "Enter your own numeric Telegram API ID and 32-character API hash." };
    const stored = apiId || apiHash ? "The stored Telegram API ID or hash is malformed (expected a numeric API ID and a 32-character hex API hash)." : "No Telegram API ID and hash are stored.";
    return { error: `${stored} Store them from stdin: printf '%s' "<API_ID>" | codeterm plugin config telegram-client --secret api_id, then the same for api_hash.` };
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(label) || label === "all") return { error: "Account label must use letters, numbers, hyphens, or underscores." };
  if (!fromAgent && (!host.secretSet("api_id", apiId) || !host.secretSet("api_hash", apiHash))) return { error: "Could not store Telegram API credentials in the host secret store." };
  const setup = ensureAccount(label, apiId, apiHash);
  if (setup.error) return { error: setup.error };
  const logFile = childPath(p.root, `login-${label}.log`);
  try {
    host.fs.removeFile(logFile);
  } catch {
  }
  const job = startTg(["--account", label, "login", "--output", "json"], twoFactorPassword ? { TG_PASSWORD: twoFactorPassword } : {}, { detach: true, logFile });
  if (job.error || !job.jobId) return { error: job.error || "tg login did not start." };
  loginJobs[job.jobId] = label;
  activeLoginJobId = job.jobId;
  loginLaunchPending[job.jobId] = true;
  loginLogPaths[job.jobId] = logFile;
  if (twoFactorPassword) loginPasswords[job.jobId] = twoFactorPassword;
  return { jobId: job.jobId, accountLabel: label, state: "login-in-progress", message: "Login is running. Poll progress here and scan the QR shown below." };
}
function loginPoll(jobId) {
  if (!jobId || !loginJobs[jobId]) return { error: "Unknown login job." };
  const p = paths();
  if (!p) return { error: "The host home directory is unavailable." };
  if (loginLaunchPending[jobId]) {
    let launch;
    try {
      launch = host.exec.poll(jobId);
    } catch {
      return { error: "Could not read the login job." };
    }
    if (!launch.done) {
      let partial = host.fs.readFileTail(loginLogPaths[jobId], 8192) || "";
      const password = loginPasswords[jobId] || "";
      if (password) partial = partial.split(password).join("[redacted]");
      return { done: false, output: redact(partial), state: "login-in-progress", ...telegramLoginArtifacts(partial) };
    }
    try {
      host.exec.close(jobId);
    } catch {
    }
    delete loginLaunchPending[jobId];
    if (launch.error || launch.code !== 0) {
      delete loginJobs[jobId];
      delete loginPasswords[jobId];
      delete loginLogPaths[jobId];
      if (activeLoginJobId === jobId) activeLoginJobId = null;
      return { done: true, output: redact(launch.stderr || ""), error: redact(launch.error || launch.stderr || "tg login could not start."), state: "reauth-needed" };
    }
  }
  let output = host.fs.readFileTail(loginLogPaths[jobId], 8192) || "";
  const twoFactorPassword = loginPasswords[jobId] || "";
  if (twoFactorPassword) output = output.split(twoFactorPassword).join("[redacted]");
  output = redact(output);
  const label = loginJobs[jobId];
  const failure = loginFailure(output);
  if (failure) {
    delete loginJobs[jobId];
    delete loginPasswords[jobId];
    delete loginLogPaths[jobId];
    if (activeLoginJobId === jobId) activeLoginJobId = null;
    if (rejectedCredentials(failure)) resetRejectedConfig(p, label);
    return { done: true, output, state: "logged-out", error: loginFailureMessage(failure) };
  }
  const verified = jsonCommand(["--account", label, "whoami"]);
  const artifacts = telegramLoginArtifacts(output);
  if (verified.error) return { done: false, output, state: "login-in-progress", message: "Scan the QR, then refresh progress. Telegram session authorization is still pending.", ...artifacts };
  const selected = runTg(["accounts", "default", label]);
  if (!selected.ok) return { done: false, output, state: "login-in-progress", message: safeError(selected), ...artifacts };
  delete loginJobs[jobId];
  if (activeLoginJobId === jobId) activeLoginJobId = null;
  delete loginPasswords[jobId];
  delete loginLogPaths[jobId];
  try {
    host.fs.removeFile(childPath(p.root, `login-${label}.log`));
  } catch {
  }
  try {
    host.secretSet("configured_once", "true");
  } catch {
  }
  return { done: true, output, state: "logged-in", currentAccount: label, ...artifacts };
}
function removeFiles(p) {
  const entries = host.fs.readDir(p.root) || [];
  for (const entry of entries) {
    if ((/^gotd\.(session|peers)\..+\.json$/.test(entry.name) || /^login-[A-Za-z0-9_-]+\.log$/.test(entry.name)) && host.fs.fileExists(entry.path)) {
      if (!host.fs.removeFile(entry.path) && host.fs.fileExists(entry.path)) return false;
    }
  }
  const initialized = host.secretGet("config_initialized") === "true";
  if (!host.fs.removeFile(p.config) && initialized) return false;
  return true;
}
function clearSecret(name) {
  return !host.secretGet(name) || host.secretDelete(name);
}
function logout() {
  const p = paths();
  if (!p) return { error: "The host home directory is unavailable." };
  if (host.secretGet("config_initialized") === "true") {
    if (!host.fs.fileExists(p.binary)) return { error: "tg is missing. Reinstall the pinned helper, then retry logout so the Keychain session can be removed." };
    const listed = accountLabels();
    if (listed.error) return { error: "Could not list configured accounts. The config and sessions were kept so logout can be retried." };
    for (const label of listed.labels.length ? listed.labels : ["default"]) {
      const removed = runTg(["--account", label, "logout"]);
      if (!removed.ok) return { error: `Could not verify local logout for account ${label}. The config was kept so logout can be retried.` };
    }
  }
  try {
    if (!removeFiles(p)) return { error: "Could not remove the local Telegram config and session files." };
  } catch {
    return { error: "Could not remove the local Telegram config and session files." };
  }
  try {
    const apiIdDeleted = clearSecret("api_id");
    const apiHashDeleted = clearSecret("api_hash");
    const configMarkerDeleted = clearSecret("config_initialized");
    const logoutMarkerSaved = host.secretSet("configured_once", "true");
    if (!apiIdDeleted || !apiHashDeleted || !configMarkerDeleted || !logoutMarkerSaved) return { error: "Local files were removed, but the host could not update all Telegram secret state." };
  } catch {
    return { error: "Local files were removed, but the host could not update all Telegram secret state." };
  }
  return { result: "Logged out. Telegram config and local session files were removed." };
}
function onAgentCommand(ctx) {
  const args = Array.isArray(ctx.args) ? ctx.args : [];
  switch (ctx.verb) {
    case "login": {
      if (args.length) return { error: "Usage: login. It takes no arguments; store api_id and api_hash with --secret first." };
      const started = loginStart({}, true);
      if (started.error) return { error: `Telegram login could not start: ${started.error}` };
      const current = loginPoll(started.jobId);
      if (current.error) return { error: `Telegram login needs attention: ${current.error}` };
      return { result: JSON.stringify({
        state: String(current.state || started.state),
        jobId: started.jobId,
        qrPayload: current.qrPayload,
        tgLink: current.tgLink,
        qrSvg: current.qrSvg,
        message: current.qrPayload ? SCAN_MESSAGE : "Telegram login started. Poll login-status for the QR and tg:// link."
      }) };
    }
    case "login-status": {
      if (args.length) return { error: "Usage: login-status." };
      if (!activeLoginJobId) return { result: JSON.stringify({ state: status().state, done: true }) };
      const current = loginPoll(activeLoginJobId);
      if (current.error) return { error: `Telegram login needs attention: ${current.error}` };
      return { result: JSON.stringify({
        done: current.done === true,
        state: String(current.state || "login-in-progress"),
        currentAccount: current.currentAccount,
        qrPayload: current.qrPayload,
        tgLink: current.tgLink,
        qrSvg: current.done ? void 0 : current.qrSvg,
        message: current.done ? "Telegram login status is complete." : current.qrPayload ? SCAN_MESSAGE : "Login is still pending; poll again for the QR and tg:// link."
      }) };
    }
    case "accounts":
      return agentAccounts();
    case "use":
      return args.length === 1 ? useAccount(args[0]) : { error: "Usage: use <configured-account-id>." };
    case "chats":
      return agentChats();
    case "history":
      return agentHistory(args);
    case "health": {
      const current = status();
      delete current.resolvedAccount;
      current.runtimeDir = paths()?.root || null;
      current.sendPolicy = policySummary();
      current.sendState = latestSendState();
      return { result: JSON.stringify(current) };
    }
    case "logout":
      return logout();
    case "send":
      return sendCommand(ctx.sessionId, args);
    case "preview":
      return previewCommand(args, "agent");
    default:
      return { error: `Unknown Telegram verb: ${ctx.verb}` };
  }
}
function latestSendState() {
  const p = paths();
  if (!p) return null;
  const loaded = loadOutbox(p);
  let persisted = null;
  if (loaded.ledger && loaded.ledger.attempts.length) {
    const attempt = loaded.ledger.attempts.reduce((latest, item) => Number(item.updatedAt) >= Number(latest.updatedAt) ? item : latest);
    persisted = {
      state: attempt.state,
      failure: attempt.failure || null,
      message: attempt.failureMessage || (attempt.state === "sent" ? "Telegram confirmed acceptance." : null),
      retryAfter: attempt.retryAfter || null,
      destination: attempt.destination,
      updatedAt: attempt.updatedAt
    };
  }
  if (transientSendFailure && (!persisted || transientSendFailure.updatedAt >= persisted.updatedAt)) {
    return { state: transientSendFailure.state, failure: transientSendFailure.state, message: transientSendFailure.message, retryAfter: null, destination: null, updatedAt: transientSendFailure.updatedAt };
  }
  return persisted;
}
function renderGlance() {
  const p = paths();
  const nodes = [];
  if (!p || !host.fs.fileExists(p.binary)) {
    nodes.push({ kind: "badge", label: "tg not installed", tone: "warn" });
    nodes.push({ kind: "text", text: "Use Configure with AI to install the pinned release and sign in.", style: { tone: "muted" } });
  } else if (host.secretGet("config_initialized") !== "true") {
    nodes.push({ kind: "badge", label: "Not signed in", tone: "warn" });
    nodes.push({ kind: "text", text: "Use Configure with AI or the Telegram Client view to sign in.", style: { tone: "muted" } });
  } else {
    nodes.push({ kind: "badge", label: "Configured", tone: "ok" });
    nodes.push({ kind: "text", text: storageBackend().name, style: { tone: "muted" } });
  }
  const policy = policySummary();
  nodes.push({ kind: "badge", label: policy.configured ? "Saved Messages send policy enabled" : "Sending locked: owner policy required", tone: policy.configured ? "ok" : "warn" });
  const latest = latestSendState();
  if (latest) {
    nodes.push({ kind: "badge", label: `Last send: ${latest.state}`, tone: latest.state === "sent" ? "ok" : "warn" });
    if (latest.message) nodes.push({ kind: "text", text: latest.message, style: { tone: "muted" } });
  }
  return { title: "Telegram Client", nodes };
}
function viewCall(method, args) {
  args = args || {};
  if (method === "status") {
    const current = status();
    current.loginJobId = activeLoginJobId;
    current.sendPolicy = policySummary();
    current.sendState = latestSendState();
    return current;
  }
  if (method === "preview") return previewCommand([String(args.chatId || ""), String(args.text || "")], "view");
  if (method === "setSendPolicy") return setSendPolicy(args);
  if (method === "send") {
    const request = [String(args.chatId || "")];
    if (args.idempotencyKey) request.push("--key", String(args.idempotencyKey));
    request.push(String(args.text || ""));
    const token = previewTokens[String(args.previewId || "")];
    if (!token || token.destination.id !== request[0] || token.text !== String(args.text || "")) {
      return rememberSendFailure("destination-not-permitted", "destination-not-permitted: This view has no matching resolved preview. Review the sender, immutable destination, and exact text again before sending.");
    }
    request.push("--key", token.previewNonce);
    return sendCommand("plugin-view", request);
  }
  if (method === "loginStart") return loginStart(args);
  if (method === "loginPoll") return loginPoll(String(args.jobId || ""));
  if (method === "useAccount") return useAccount(String(args.id || ""));
  if (method === "logout") return logout();
  return { error: `Unknown Telegram view method: ${method}` };
}
var plugin = {
  onAgentCommand,
  renderGlance,
  viewCall,
  __test_paths: paths,
  __test_binaryName: binaryName,
  __test_options: options,
  __test_utf8Bytes: utf8Bytes,
  __test_boundedHistory: boundedHistory,
  __test_validChatId: validChatId,
  __test_chatId: chatId,
  __test_storageBackend: storageBackend,
  __test_versionOlder: versionOlder,
  __test_status: status,
  __test_loginStart: loginStart,
  __test_loginPoll: loginPoll,
  __test_loginFailure: loginFailure,
  __test_loginFailureMessage: loginFailureMessage,
  __test_logout: logout,
  __test_agentHistory: agentHistory,
  __test_setClock: (clock) => {
    injectedClock = clock;
  },
  __test_sha256Hex: sha256Hex,
  __test_policySummary: policySummary,
  __test_latestSendState: latestSendState,
  __test_failureMessage: failureMessage,
  __test_failureForUpstream: failureForUpstream
};
var plugin_default = plugin;
