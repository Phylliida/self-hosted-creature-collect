#!/usr/bin/env ruby
# Extract a Pokémon Infinite Fusion .dat file (Ruby Marshal binary
# format) into JSON on stdout. Used by build-bundled-data.py to read
# species names / types / evolutions without needing the pre-extracted
# JSON in data/Battlers/.
#
# Usage:
#   ruby extract-pif-dat.rb <path/to/file.dat>
#
# Strategy: PIF's GameData::* classes use Ruby's default Marshal
# serialisation (no _dump / marshal_dump overrides), so Marshal.load
# instantiates them via Class#allocate + sets instance variables
# directly. Stub classes with nothing in their body are enough for
# loading to succeed; we then walk the result and emit JSON, mapping:
#   - Symbol → String
#   - Stub object → Hash of @-stripped instance variables
#   - Hash keys: Symbol → String (so JSON output uses string keys)

require 'json'

module GameData
  class GenericStub
    def to_marshalled_hash
      data = {}
      instance_variables.each do |iv|
        data[iv.to_s.delete_prefix('@')] = instance_variable_get(iv)
      end
      data
    end
  end

  # Stubs for every GameData class PIF might reference inside a .dat
  # file. Adding more here as new file types come up costs nothing —
  # the generic stub just absorbs whatever instance variables Marshal
  # tries to set on it.
  class Species < GenericStub; end
  class SpeciesMetrics < GenericStub; end
  class Type < GenericStub; end
  class Move < GenericStub; end
  class Item < GenericStub; end
  class Ability < GenericStub; end
  class Encounter < GenericStub; end
  class EncounterTable < GenericStub; end
  class Trainer < GenericStub; end
  class TrainerType < GenericStub; end
  class Ribbon < GenericStub; end
  class BerryPlant < GenericStub; end
  class MapMetadata < GenericStub; end
  class Metadata < GenericStub; end
  class TownMap < GenericStub; end
end

# Some PIF data references Color / Tone (Ruby/RGSS classes that
# don't exist outside the game runtime). Stub them as generic
# objects too so the load doesn't blow up.
class Color < GameData::GenericStub; end unless defined?(Color)
class Tone < GameData::GenericStub; end unless defined?(Tone)

# Recursively normalise the loaded structure for JSON output. The
# JSON format can't represent symbols or arbitrary Ruby objects, so
# everything funnels through here.
def normalise(v)
  case v
  when Symbol
    v.to_s
  when GameData::GenericStub
    normalise(v.to_marshalled_hash)
  when Hash
    out = {}
    v.each do |k, val|
      key = k.is_a?(Symbol) ? k.to_s : k.to_s
      out[key] = normalise(val)
    end
    out
  when Array
    v.map { |x| normalise(x) }
  when nil, true, false, Integer, Float, String
    v
  else
    # Fallback for anything we forgot to stub — emit a marker hash
    # so the caller can see what was missed.
    { "__unhandled__" => v.class.name, "__inspect__" => v.inspect[0..200] }
  end
end

# Infinite Fusion 6.7+ ("performance" builds) XOR-encrypts its Data/*.dat
# files with a 16-byte repeating key before writing them; the game
# decrypts in Data/Scripts/001_Technical/000_Encryption.rb and falls back
# to plain Marshal when the magic bytes already read \x04\x08. Mirror
# that: decrypt only when the Marshal magic is missing.
IF2_XOR_KEY = [0x4A, 0x8F, 0x2C, 0xE1, 0x73, 0xB5, 0x96, 0x0D,
               0x5E, 0xA2, 0x3F, 0xC7, 0x81, 0x14, 0x6B, 0xD9].freeze

def maybe_decrypt(raw)
  return raw if raw.start_with?("\x04\x08".b)
  raw.bytes.each_with_index.map { |b, i| b ^ IF2_XOR_KEY[i % IF2_XOR_KEY.length] }.pack("C*")
end

path = ARGV[0] or abort("usage: ruby extract-pif-dat.rb <path/to/file.dat>")
abort("not a file: #{path}") unless File.file?(path)
data = Marshal.load(maybe_decrypt(File.binread(path)))
$stdout.write(JSON.generate(normalise(data)))
