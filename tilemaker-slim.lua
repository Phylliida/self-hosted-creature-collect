-- tilemaker-slim.lua
--
-- Thin wrapper around tilemaker's upstream process-openmaptiles.lua that
-- drops layers and fields the self-hosted-creature-collect client never
-- reads. The goal is smaller mbtiles without having to edit the 800+-line
-- stock script. We override tilemaker's Layer()/Attribute*() functions and
-- then dofile the stock script — all of its emissions route through our
-- filters.
--
-- Drops (set in `_droppedLayers`):
--   waterway, waterway_detail  (river/stream LINES — we render nothing)
--   aeroway                     (runways / taxiways)
--   mountain_peak
--
-- Kept, but with field allowlists to strip unused attributes from each tile:
--   transportation:        class
--   transportation_name:   class, name:latin/name/name_int
--   building:              geometry only
--   landuse, landcover:    geometry only (flat fill)
--   poi:                   class, subclass
--   place:                 class, name:latin/name/name_int
--   housenumber:           housenumber
--   water:                 class
--   water_name:            class, name:latin/name
--   aerodrome_label:       class, name:latin/name
--   park:                  class, name:latin/name
--   boundary:              admin_level, class, maritime, disputed

local SHARE = os.getenv('TILEMAKER_SHARE')
          or '/nix/store/wpga93ncp3cp2c14a5sjndfyr7ra39cj-tilemaker-3.0.0/share/tilemaker'

local _droppedLayers = {
	waterway = true, waterway_detail = true,
	aeroway = true,
	mountain_peak = true,
}

-- One allowlist covers each tile-output name, including its write_to aliases
-- (e.g. transportation_name_mid maps to transportation_name but the lua still
-- calls Layer("transportation_name_mid"), so we list it too).
local common_name_fields = {
	class = true,
	['name:latin'] = true,
	['name'] = true,
	['name_int'] = true,
}
local _allowedFields = {
	transportation              = { class = true },
	transportation_name         = common_name_fields,
	transportation_name_mid     = common_name_fields,
	transportation_name_detail  = common_name_fields,
	building                    = {},
	landuse                     = {},
	landcover                   = {},
	poi                         = { class = true, subclass = true },
	poi_detail                  = { class = true, subclass = true },
	place                       = common_name_fields,
	housenumber                 = { housenumber = true },
	water                       = { class = true },
	water_name                  = { class = true, ['name:latin'] = true, ['name'] = true },
	water_name_detail           = { class = true, ['name:latin'] = true, ['name'] = true },
	aerodrome_label             = { class = true, ['name:latin'] = true, ['name'] = true },
	park                        = { class = true, ['name:latin'] = true, ['name'] = true },
	boundary                    = { admin_level = true, class = true, maritime = true, disputed = true },
}

-- Save originals so we can call them after our filter passes.
local _Layer             = Layer
local _Attribute         = Attribute
local _AttributeNumeric  = AttributeNumeric
local _AttributeBoolean  = AttributeBoolean

local DROPPED = '__DROPPED__'
local _active = nil

function Layer(name, isArea)
	if _droppedLayers[name] then
		_active = DROPPED
		return
	end
	_active = name
	_Layer(name, isArea)
end

local function _shouldDrop(key)
	if _active == DROPPED then return true end
	local allow = _allowedFields[_active]
	if allow == nil then return false end
	return not allow[key]
end

function Attribute(key, value)
	if _shouldDrop(key) then return end
	_Attribute(key, value)
end
function AttributeNumeric(key, value)
	if _shouldDrop(key) then return end
	_AttributeNumeric(key, value)
end
function AttributeBoolean(key, value)
	if _shouldDrop(key) then return end
	_AttributeBoolean(key, value)
end

-- Now load the stock lua. Its node_function / way_function / etc. will call
-- our overridden Layer/Attribute and be filtered in place.
dofile(SHARE .. '/process-openmaptiles.lua')
