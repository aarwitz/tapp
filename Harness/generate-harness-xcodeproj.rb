#!/usr/bin/env ruby
# generate-harness-xcodeproj.rb — Generates OCQAHarness.xcodeproj
# Run from the Harness/ directory

require 'fileutils'
require 'digest'

harness_dir = File.dirname(File.expand_path(__FILE__))
xcodeproj_dir = "#{harness_dir}/OCQAHarness.xcodeproj"
FileUtils.mkdir_p(xcodeproj_dir)

def uuid(seed)
  Digest::MD5.hexdigest("ocqa-harness-#{seed}").upcase[0, 24]
end

pbxproj = <<~PBX
// !$*UTF8*$!
{
  archiveVersion = 1;
  classes = {};
  objectVersion = 56;
  objects = {
    #{uuid('project')} /* Project object */ = {
      isa = PBXProject;
      buildConfigurationList = #{uuid('project-configs')};
      compatibilityVersion = "Xcode 14.0";
      developmentRegion = en;
      hasScannedForEncodings = 0;
      knownRegions = (en, Base);
      mainGroup = #{uuid('main-group')};
      productRefGroup = #{uuid('products-group')};
      projectDirPath = "";
      projectRoot = "";
      targets = (
        #{uuid('app-target')},
        #{uuid('test-target')},
      );
    };

    /* Main Group */
    #{uuid('main-group')} = {
      isa = PBXGroup;
      children = (
        #{uuid('app-group')},
        #{uuid('test-group')},
        #{uuid('products-group')},
      );
      sourceTree = "<group>";
    };
    #{uuid('products-group')} = {
      isa = PBXGroup;
      children = (
        #{uuid('app-product')},
        #{uuid('test-product')},
      );
      name = Products;
      sourceTree = "<group>";
    };
    #{uuid('app-group')} = {
      isa = PBXGroup;
      children = (
        #{uuid('appdelegate-ref')},
        #{uuid('app-info-ref')},
      );
      path = OCQAHarness;
      sourceTree = "<group>";
    };
    #{uuid('test-group')} = {
      isa = PBXGroup;
      children = (
        #{uuid('explorer-ref')},
        #{uuid('test-info-ref')},
      );
      path = OCQAHarnessUITests;
      sourceTree = "<group>";
    };

    /* File References */
    #{uuid('appdelegate-ref')} = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = AppDelegate.swift; sourceTree = "<group>";};
    #{uuid('app-info-ref')} = {isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = Info.plist; sourceTree = "<group>";};
    #{uuid('explorer-ref')} = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ExplorerTests.swift; sourceTree = "<group>";};
    #{uuid('test-info-ref')} = {isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = Info.plist; sourceTree = "<group>";};
    #{uuid('app-product')} = {isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = OCQAHarness.app; sourceTree = BUILT_PRODUCTS_DIR;};
    #{uuid('test-product')} = {isa = PBXFileReference; explicitFileType = wrapper.cfbundle; includeInIndex = 0; path = OCQAHarnessUITests.xctest; sourceTree = BUILT_PRODUCTS_DIR;};

    /* Build Files */
    #{uuid('appdelegate-build')} = {isa = PBXBuildFile; fileRef = #{uuid('appdelegate-ref')};};
    #{uuid('explorer-build')} = {isa = PBXBuildFile; fileRef = #{uuid('explorer-ref')};};

    /* Source Build Phases */
    #{uuid('app-sources')} = {
      isa = PBXSourcesBuildPhase;
      buildActionMask = 2147483647;
      files = (#{uuid('appdelegate-build')},);
      runOnlyForDeploymentPostprocessing = 0;
    };
    #{uuid('test-sources')} = {
      isa = PBXSourcesBuildPhase;
      buildActionMask = 2147483647;
      files = (#{uuid('explorer-build')},);
      runOnlyForDeploymentPostprocessing = 0;
    };

    /* Frameworks Build Phases */
    #{uuid('app-frameworks')} = {isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0;};
    #{uuid('test-frameworks')} = {isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0;};

    /* App Target */
    #{uuid('app-target')} = {
      isa = PBXNativeTarget;
      buildConfigurationList = #{uuid('app-configs')};
      buildPhases = (#{uuid('app-sources')}, #{uuid('app-frameworks')},);
      buildRules = ();
      dependencies = ();
      name = OCQAHarness;
      productName = OCQAHarness;
      productReference = #{uuid('app-product')};
      productType = "com.apple.product-type.application";
    };

    /* Test Target */
    #{uuid('test-target')} = {
      isa = PBXNativeTarget;
      buildConfigurationList = #{uuid('test-configs')};
      buildPhases = (#{uuid('test-sources')}, #{uuid('test-frameworks')},);
      buildRules = ();
      dependencies = (#{uuid('test-dep')},);
      name = OCQAHarnessUITests;
      productName = OCQAHarnessUITests;
      productReference = #{uuid('test-product')};
      productType = "com.apple.product-type.bundle.ui-testing";
    };

    /* Target Dependency */
    #{uuid('test-dep')} = {
      isa = PBXTargetDependency;
      target = #{uuid('app-target')};
      targetProxy = #{uuid('test-proxy')};
    };
    #{uuid('test-proxy')} = {
      isa = PBXContainerItemProxy;
      containerPortal = #{uuid('project')};
      proxyType = 1;
      remoteGlobalIDString = #{uuid('app-target')};
      remoteInfo = OCQAHarness;
    };

    /* Build Configurations */
    #{uuid('project-configs')} = {
      isa = XCConfigurationList;
      buildConfigurations = (#{uuid('project-debug')},);
      defaultConfigurationIsVisible = 0;
      defaultConfigurationName = Debug;
    };
    #{uuid('project-debug')} = {
      isa = XCBuildConfiguration;
      buildSettings = {
        ALWAYS_SEARCH_USER_PATHS = NO;
        CLANG_ENABLE_MODULES = YES;
        CODE_SIGN_IDENTITY = "-";
        CODE_SIGN_STYLE = Automatic;
        DEVELOPMENT_TEAM = "";
        ENABLE_TESTABILITY = YES;
        IPHONEOS_DEPLOYMENT_TARGET = 16.0;
        SDKROOT = iphoneos;
        SWIFT_VERSION = 5.0;
        TARGETED_DEVICE_FAMILY = "1,2";
      };
      name = Debug;
    };
    #{uuid('app-configs')} = {
      isa = XCConfigurationList;
      buildConfigurations = (#{uuid('app-debug')},);
      defaultConfigurationIsVisible = 0;
      defaultConfigurationName = Debug;
    };
    #{uuid('app-debug')} = {
      isa = XCBuildConfiguration;
      buildSettings = {
        ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;
        CODE_SIGN_IDENTITY = "-";
        CODE_SIGN_STYLE = Automatic;
        DEVELOPMENT_TEAM = "";
        INFOPLIST_FILE = OCQAHarness/Info.plist;
        PRODUCT_BUNDLE_IDENTIFIER = ai.autotap.harness;
        PRODUCT_NAME = "$(TARGET_NAME)";
        SWIFT_VERSION = 5.0;
        TARGETED_DEVICE_FAMILY = "1,2";
      };
      name = Debug;
    };
    #{uuid('test-configs')} = {
      isa = XCConfigurationList;
      buildConfigurations = (#{uuid('test-debug')},);
      defaultConfigurationIsVisible = 0;
      defaultConfigurationName = Debug;
    };
    #{uuid('test-debug')} = {
      isa = XCBuildConfiguration;
      buildSettings = {
        CODE_SIGN_IDENTITY = "-";
        CODE_SIGN_STYLE = Automatic;
        DEVELOPMENT_TEAM = "";
        INFOPLIST_FILE = OCQAHarnessUITests/Info.plist;
        PRODUCT_BUNDLE_IDENTIFIER = ai.autotap.harness.uitests;
        PRODUCT_NAME = "$(TARGET_NAME)";
        SWIFT_VERSION = 5.0;
        TARGETED_DEVICE_FAMILY = "1,2";
        TEST_TARGET_NAME = OCQAHarness;
      };
      name = Debug;
    };
  };
  rootObject = #{uuid('project')};
}
PBX

File.write("#{xcodeproj_dir}/project.pbxproj", pbxproj)

# Create scheme
scheme_dir = "#{xcodeproj_dir}/xcshareddata/xcschemes"
FileUtils.mkdir_p(scheme_dir)

scheme = <<~SCHEME
<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion = "1620" version = "1.7">
   <BuildAction parallelizeBuildables = "YES" buildImplicitDependencies = "YES">
      <BuildActionEntries>
         <BuildActionEntry buildForTesting = "YES" buildForRunning = "YES" buildForProfiling = "YES" buildForArchiving = "YES" buildForAnalyzing = "YES">
            <BuildableReference BuildableIdentifier = "primary" BlueprintIdentifier = "#{uuid('test-target')}" BuildableName = "OCQAHarnessUITests.xctest" BlueprintName = "OCQAHarnessUITests" ReferencedContainer = "container:OCQAHarness.xcodeproj"/>
         </BuildActionEntry>
      </BuildActionEntries>
   </BuildAction>
   <TestAction buildConfiguration = "Debug" selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv = "YES">
      <Testables>
         <TestableReference skipped = "NO">
            <BuildableReference BuildableIdentifier = "primary" BlueprintIdentifier = "#{uuid('test-target')}" BuildableName = "OCQAHarnessUITests.xctest" BlueprintName = "OCQAHarnessUITests" ReferencedContainer = "container:OCQAHarness.xcodeproj"/>
         </TestableReference>
      </Testables>
   </TestAction>
   <LaunchAction buildConfiguration = "Debug" selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB" launchStyle = "0" useCustomWorkingDirectory = "NO" ignoresPersistentStateOnLaunch = "NO" debugDocumentVersioning = "YES" debugServiceExtension = "internal" allowLocationSimulation = "YES">
      <BuildableProductRunnable runnableDebuggingMode = "0">
         <BuildableReference BuildableIdentifier = "primary" BlueprintIdentifier = "#{uuid('app-target')}" BuildableName = "OCQAHarness.app" BlueprintName = "OCQAHarness" ReferencedContainer = "container:OCQAHarness.xcodeproj"/>
      </BuildableProductRunnable>
   </LaunchAction>
</Scheme>
SCHEME

File.write("#{scheme_dir}/OCQAHarnessUITests.xcscheme", scheme)

puts "✅ Generated OCQAHarness.xcodeproj"
puts "   Host app: ai.autotap.harness"
puts "   Test target: OCQAHarnessUITests"
puts "   Platform: iOS 16.0+"
