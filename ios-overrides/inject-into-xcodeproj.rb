# Add our custom Swift files to the Xcode project so xcodebuild
# compiles them. Uses the `xcodeproj` gem (CocoaPods ships it).
#
# Idempotent — checks whether the file refs exist before adding.

require 'xcodeproj'

PROJECT_PATH = 'ios/App/App.xcodeproj'
APP_GROUP = 'App'  # the source-file group inside the project
TARGET = 'App'     # the build target
NEW_FILES = ['LocalServer.swift', 'AppBridgeViewController.swift', 'BundleAccessPlugin.swift', 'MemoryProbePlugin.swift', 'LocalServerDiagPlugin.swift', 'MotionPedometerPlugin.swift', 'HapticPatternPlugin.swift', 'SensorProbePlugin.swift', 'SaveImagePlugin.swift']

project = Xcodeproj::Project.open(PROJECT_PATH)

target = project.targets.find { |t| t.name == TARGET }
abort("ERROR: target #{TARGET} not found") unless target

group = project.main_group[APP_GROUP]
abort("ERROR: group #{APP_GROUP} not found") unless group

added = 0
NEW_FILES.each do |fname|
  if group.files.any? { |f| f.path == fname || f.display_name == fname }
    puts "  skip: #{fname} already in project"
    next
  end
  ref = group.new_reference(fname)
  target.source_build_phase.add_file_reference(ref)
  added += 1
  puts "  added: #{fname}"
end

if added > 0
  project.save
  puts "Saved #{PROJECT_PATH} with #{added} new file(s)"
else
  puts "No changes needed"
end

# Ensure `public` is a *folder reference* (lastKnownFileType=folder)
# rather than a *group*. Capacitor 6's iOS template should add it as a
# folder reference, but we've observed builds where it ends up as a
# group — the visible symptom is that top-level webDir files (e.g.
# /bundled-data/icons-list.json) bundle correctly, but anything in a
# subdirectory (/bundled-data/icons/cafe.svg) silently drops out of
# the .app. We rebuild the reference to be sure.
puts ""
puts "── verifying public folder reference ──"
existing = group.children.select do |c|
  (c.respond_to?(:path) && c.path == 'public') ||
  (c.respond_to?(:name) && c.display_name == 'public')
end
public_ref = nil
existing.each do |c|
  if c.is_a?(Xcodeproj::Project::Object::PBXFileReference) &&
     c.last_known_file_type == 'folder'
    puts "  found correct folder reference for public — leaving as-is"
    public_ref = c
  else
    puts "  removing public ref of wrong type: #{c.class}"
    target.resources_build_phase.files.dup.each do |bf|
      target.resources_build_phase.remove_build_file(bf) if bf.file_ref == c
    end
    c.remove_from_project
  end
end
unless public_ref
  puts "  adding public as a folder reference"
  ref = group.new_reference('public')
  ref.last_known_file_type = 'folder'
  ref.source_tree = '<group>'
  target.resources_build_phase.add_file_reference(ref)
  public_ref = ref
end

project.save
puts "Saved #{PROJECT_PATH}"

# ───────────────────────────────────────────────────────────────────────────
# Custom-keyboard app-extension target (UnicodeKeyboard).
#
# Capacitor scaffolds only the App target; a system-wide custom keyboard is a
# separate app-extension target with its own bundle id, Info.plist and product,
# embedded into App via a PlugIns copy-files phase. Idempotent: skips if the
# target already exists. The keyboard's sources + UnicodeData/ resources are
# copied into ios/App/App/UnicodeKeyboard/ by the build workflow before this
# script runs.
# ───────────────────────────────────────────────────────────────────────────
puts ""
puts "── keyboard extension target ──"

KB_TARGET = 'UnicodeKeyboard'
KB_BUNDLE_ID = 'org.phylliidaassets.creaturecollect.keyboard'
KB_SOURCES = ['KeyboardViewController.swift', 'UnicodeStore.swift', 'RecentsStore.swift', 'SearchKeyboardView.swift']

app_target = project.targets.find { |t| t.name == 'App' }
abort('ERROR: App target not found') unless app_target

if project.targets.any? { |t| t.name == KB_TARGET }
  puts "  skip: target #{KB_TARGET} already exists"
else
  kb = project.new_target(:app_extension, KB_TARGET, :ios, '14.0')

  # Build settings — mirror the unsigned-sideload setup used for the App target.
  kb.build_configurations.each do |config|
    bs = config.build_settings
    bs['PRODUCT_BUNDLE_IDENTIFIER'] = KB_BUNDLE_ID
    bs['PRODUCT_NAME'] = '$(TARGET_NAME)'
    bs['INFOPLIST_FILE'] = 'App/UnicodeKeyboard/Info.plist'
    bs['IPHONEOS_DEPLOYMENT_TARGET'] = '14.0'
    bs['TARGETED_DEVICE_FAMILY'] = '1,2'
    bs['SWIFT_VERSION'] = '5.0'
    bs['GENERATE_INFOPLIST_FILE'] = 'NO'
    bs['SKIP_INSTALL'] = 'NO'
    bs['ALWAYS_EMBED_SWIFT_STANDARD_LIBRARIES'] = 'NO'
    bs['CODE_SIGNING_ALLOWED'] = 'NO'
    bs['CODE_SIGNING_REQUIRED'] = 'NO'
    bs['CODE_SIGN_IDENTITY'] = ''
    bs['LD_RUNPATH_SEARCH_PATHS'] = ['$(inherited)', '@executable_path/Frameworks', '@executable_path/../../Frameworks']
  end

  # A real (path-bearing) group at App/UnicodeKeyboard so file references resolve
  # to ios/App/App/UnicodeKeyboard/<file>. Do NOT use find_subpath here: it
  # creates a name-only *virtual* group (no path), which makes references resolve
  # against the parent App group's dir (ios/App/App/<file>), dropping the
  # UnicodeKeyboard/ segment — that mislocated the bundled data folder.
  app_source_group = project.main_group['App']
  kb_group = app_source_group.groups.find { |g| g.display_name == 'UnicodeKeyboard' }
  kb_group ||= app_source_group.new_group('UnicodeKeyboard', 'UnicodeKeyboard')

  KB_SOURCES.each do |fname|
    ref = kb_group.new_reference(fname)
    kb.source_build_phase.add_file_reference(ref)
    puts "  source: #{fname}"
  end

  # Bundled Unicode dataset as a folder reference (copied recursively into the
  # appex's Resources).
  data_ref = kb_group.new_reference('UnicodeData')
  data_ref.last_known_file_type = 'folder'
  kb.resources_build_phase.add_file_reference(data_ref)
  puts "  resource: UnicodeData/ (folder reference)"

  # Make App depend on + embed the appex (PlugIns destination).
  app_target.add_dependency(kb)
  embed = app_target.copy_files_build_phases.find { |p| p.symbol_dst_subfolder_spec == :plug_ins }
  unless embed
    embed = app_target.new_copy_files_build_phase('Embed App Extensions')
    embed.symbol_dst_subfolder_spec = :plug_ins
  end
  unless embed.files.any? { |bf| bf.file_ref == kb.product_reference }
    build_file = embed.add_file_reference(kb.product_reference)
    build_file.settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] }
  end
  puts "  embedded appex into App + added target dependency"

  project.save
  puts "Saved #{PROJECT_PATH} with #{KB_TARGET} extension"
end
