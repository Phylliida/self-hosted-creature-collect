# Add our custom Swift files to the Xcode project so xcodebuild
# compiles them. Uses the `xcodeproj` gem (CocoaPods ships it).
#
# Idempotent — checks whether the file refs exist before adding.

require 'xcodeproj'

PROJECT_PATH = 'ios/App/App.xcodeproj'
APP_GROUP = 'App'  # the source-file group inside the project
TARGET = 'App'     # the build target
NEW_FILES = ['LocalServer.swift', 'AppBridgeViewController.swift']

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
