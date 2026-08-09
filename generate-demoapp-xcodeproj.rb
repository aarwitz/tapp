#!/usr/bin/env ruby
# generate-demoapp-xcodeproj.rb — Generates DemoApp/DemoApp.xcodeproj/project.pbxproj
# Run from the repo root: ruby generate-demoapp-xcodeproj.rb

require 'digest'
require 'fileutils'

$uuid_counter = 0
def make_uuid(seed)
  $uuid_counter += 1
  Digest::MD5.hexdigest("#{seed}-#{$uuid_counter}").upcase[0, 24]
end

demo_dir   = File.join(File.dirname(__FILE__), 'DemoApp')
source_dir = File.join(demo_dir, 'Sources')
plist_file = File.join(demo_dir, 'Info.plist')

swift_files = Dir.glob(File.join(source_dir, '*.swift')).sort

file_refs  = {}
build_files = {}
swift_files.each do |f|
  rel = File.basename(f)
  file_refs[rel]  = make_uuid("fileref-#{rel}")
  build_files[rel] = make_uuid("buildfile-#{rel}")
end

plist_ref   = make_uuid("fileref-info-plist")
root_group  = make_uuid("root-group")
src_group   = make_uuid("src-group")
prod_group  = make_uuid("products-group")

project_uuid       = make_uuid("project")
target_uuid        = make_uuid("target")
product_ref        = make_uuid("product-ref")
build_cfg_debug    = make_uuid("build-cfg-debug")
build_cfg_release  = make_uuid("build-cfg-release")
tgt_cfg_debug      = make_uuid("tgt-cfg-debug")
tgt_cfg_release    = make_uuid("tgt-cfg-release")
cfg_list           = make_uuid("cfg-list")
tgt_cfg_list       = make_uuid("tgt-cfg-list")
sources_phase      = make_uuid("sources-phase")
resources_phase    = make_uuid("resources-phase")
frameworks_phase   = make_uuid("frameworks-phase")

proj_dir = File.join(demo_dir, 'DemoApp.xcodeproj')
FileUtils.mkdir_p(proj_dir)

pbxproj = <<~PBXPROJ
  // !$*UTF8*$!
  {
  	archiveVersion = 1;
  	classes = {};
  	objectVersion = 56;
  	objects = {

  /* PBXBuildFile section */
  #{build_files.map { |rel, uuid| "\t\t#{uuid} /* #{rel} in Sources */ = {isa = PBXBuildFile; fileRef = #{file_refs[rel]} /* #{rel} */; };" }.join("\n")}

  /* PBXFileReference section */
  #{file_refs.map { |rel, uuid| "\t\t#{uuid} /* #{rel} */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; name = #{rel}; path = Sources/#{rel}; sourceTree = \"<group>\"; };" }.join("\n")}
  		#{plist_ref} /* Info.plist */ = {isa = PBXFileReference; lastKnownFileType = text.plist.xml; name = Info.plist; path = Info.plist; sourceTree = \"<group>\"; };
  		#{product_ref} /* DemoApp.app */ = {isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = DemoApp.app; sourceTree = BUILT_PRODUCTS_DIR; };

  /* PBXFrameworksBuildPhase section */
  		#{frameworks_phase} /* Frameworks */ = {
  			isa = PBXFrameworksBuildPhase;
  			buildActionMask = 2147483647;
  			files = ();
  			runOnlyForDeploymentPostprocessing = 0;
  		};

  /* PBXGroup section */
  		#{root_group} = {
  			isa = PBXGroup;
  			children = (
  				#{src_group} /* Sources */,
  				#{plist_ref} /* Info.plist */,
  				#{prod_group} /* Products */,
  			);
  			sourceTree = "<group>";
  		};
  		#{src_group} /* Sources */ = {
  			isa = PBXGroup;
  			children = (
  				#{file_refs.values.join(",\n\t\t\t\t")}
  			);
  			name = Sources;
  			sourceTree = "<group>";
  		};
  		#{prod_group} /* Products */ = {
  			isa = PBXGroup;
  			children = (
  				#{product_ref} /* DemoApp.app */,
  			);
  			name = Products;
  			sourceTree = "<group>";
  		};

  /* PBXNativeTarget section */
  		#{target_uuid} /* DemoApp */ = {
  			isa = PBXNativeTarget;
  			buildConfigurationList = #{tgt_cfg_list};
  			buildPhases = (
  				#{sources_phase} /* Sources */,
  				#{frameworks_phase} /* Frameworks */,
  				#{resources_phase} /* Resources */,
  			);
  			buildRules = ();
  			dependencies = ();
  			name = DemoApp;
  			productName = DemoApp;
  			productReference = #{product_ref} /* DemoApp.app */;
  			productType = "com.apple.product-type.application";
  		};

  /* PBXProject section */
  		#{project_uuid} /* Project object */ = {
  			isa = PBXProject;
  			buildConfigurationList = #{cfg_list};
  			compatibilityVersion = "Xcode 14.0";
  			developmentRegion = en;
  			hasScannedForEncodings = 0;
  			knownRegions = (en, Base);
  			mainGroup = #{root_group};
  			productRefGroup = #{prod_group};
  			projectDirPath = "";
  			projectRoot = "";
  			targets = (
  				#{target_uuid} /* DemoApp */,
  			);
  		};

  /* PBXResourcesBuildPhase section */
  		#{resources_phase} /* Resources */ = {
  			isa = PBXResourcesBuildPhase;
  			buildActionMask = 2147483647;
  			files = ();
  			runOnlyForDeploymentPostprocessing = 0;
  		};

  /* PBXSourcesBuildPhase section */
  		#{sources_phase} /* Sources */ = {
  			isa = PBXSourcesBuildPhase;
  			buildActionMask = 2147483647;
  			files = (
  				#{build_files.values.join(",\n\t\t\t\t")}
  			);
  			runOnlyForDeploymentPostprocessing = 0;
  		};

  /* XCBuildConfiguration section */
  		#{build_cfg_debug} /* Debug */ = {
  			isa = XCBuildConfiguration;
  			buildSettings = {
  				ALWAYS_SEARCH_USER_PATHS = NO;
  				CLANG_ENABLE_MODULES = YES;
  				CODE_SIGN_IDENTITY = "";
  				CODE_SIGNING_ALLOWED = NO;
  				CODE_SIGNING_REQUIRED = NO;
  				SWIFT_VERSION = 5.0;
  				SDKROOT = iphoneos;
  				ONLY_ACTIVE_ARCH = YES;
  			};
  			name = Debug;
  		};
  		#{build_cfg_release} /* Release */ = {
  			isa = XCBuildConfiguration;
  			buildSettings = {
  				ALWAYS_SEARCH_USER_PATHS = NO;
  				CLANG_ENABLE_MODULES = YES;
  				CODE_SIGN_IDENTITY = "";
  				CODE_SIGNING_ALLOWED = NO;
  				CODE_SIGNING_REQUIRED = NO;
  				SWIFT_VERSION = 5.0;
  				SDKROOT = iphoneos;
  			};
  			name = Release;
  		};
  		#{tgt_cfg_debug} /* Debug */ = {
  			isa = XCBuildConfiguration;
  			buildSettings = {
  				ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;
  				CODE_SIGN_IDENTITY = "";
  				CODE_SIGNING_ALLOWED = NO;
  				CODE_SIGNING_REQUIRED = NO;
  				CURRENT_PROJECT_VERSION = 1;
  				INFOPLIST_FILE = Info.plist;
  				IPHONEOS_DEPLOYMENT_TARGET = 17.0;
  				LD_RUNPATH_SEARCH_PATHS = "$(inherited) @executable_path/Frameworks";
  				MARKETING_VERSION = 1.0;
                  PRODUCT_BUNDLE_IDENTIFIER = io.github.aarwitz.tapp.demoapp;
  				PRODUCT_NAME = DemoApp;
  				SDKROOT = iphoneos;
  				SUPPORTED_PLATFORMS = "iphonesimulator iphoneos";
  				SUPPORTS_MACCATALYST = NO;
  				SWIFT_VERSION = 5.0;
  				TARGETED_DEVICE_FAMILY = 1;
  			};
  			name = Debug;
  		};
  		#{tgt_cfg_release} /* Release */ = {
  			isa = XCBuildConfiguration;
  			buildSettings = {
  				ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;
  				CODE_SIGN_IDENTITY = "";
  				CODE_SIGNING_ALLOWED = NO;
  				CODE_SIGNING_REQUIRED = NO;
  				CURRENT_PROJECT_VERSION = 1;
  				INFOPLIST_FILE = Info.plist;
  				IPHONEOS_DEPLOYMENT_TARGET = 17.0;
  				LD_RUNPATH_SEARCH_PATHS = "$(inherited) @executable_path/Frameworks";
  				MARKETING_VERSION = 1.0;
                  PRODUCT_BUNDLE_IDENTIFIER = io.github.aarwitz.tapp.demoapp;
  				PRODUCT_NAME = DemoApp;
  				SDKROOT = iphoneos;
  				SUPPORTED_PLATFORMS = "iphonesimulator iphoneos";
  				SUPPORTS_MACCATALYST = NO;
  				SWIFT_VERSION = 5.0;
  				TARGETED_DEVICE_FAMILY = 1;
  			};
  			name = Release;
  		};

  /* XCConfigurationList section */
  		#{cfg_list} /* Build configuration list for PBXProject "DemoApp" */ = {
  			isa = XCConfigurationList;
  			buildConfigurations = (
  				#{build_cfg_debug} /* Debug */,
  				#{build_cfg_release} /* Release */,
  			);
  			defaultConfigurationIsVisible = 0;
  			defaultConfigurationName = Release;
  		};
  		#{tgt_cfg_list} /* Build configuration list for PBXNativeTarget "DemoApp" */ = {
  			isa = XCConfigurationList;
  			buildConfigurations = (
  				#{tgt_cfg_debug} /* Debug */,
  				#{tgt_cfg_release} /* Release */,
  			);
  			defaultConfigurationIsVisible = 0;
  			defaultConfigurationName = Release;
  		};
  	};
  	rootObject = #{project_uuid} /* Project object */;
  }
PBXPROJ

out = File.join(proj_dir, 'project.pbxproj')
File.write(out, pbxproj)
puts "Generated: #{out}"
